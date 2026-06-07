export * as RunTurn from "./run-turn"

/**
 * Sends the next request to the model and finishes every tool call it starts.
 *
 * Before sending, it makes admitted input visible, loads the latest Session
 * history and instructions, and compacts oversized history. If the model rejects
 * the request for being too large before producing output, it may compact and
 * try once more. Returns `true` when tool results require another model request.
 */

import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { DateTime, Effect, Schema, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { SkillGuidance } from "../../skill/guidance"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { ToolRegistry } from "../../tool/registry"
import { SessionCompaction } from "../compaction"
import { SessionContextEpoch } from "../context-epoch"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import type { RunError } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { SettleProviderTurn } from "./settle-provider-turn"
import { toLLMMessages } from "./to-llm-message"

export interface Input {
  readonly sessionID: SessionSchema.ID
  readonly delivery?: SessionInput.Delivery
}

const AttemptResult = Schema.TaggedUnion({
  Complete: { needsContinuation: Schema.Boolean },
  CompactedOverflow: {},
})

export const make = Effect.gen(function* () {
  const events = yield* EventV2.Service
  const llm = yield* LLMClient.Service
  const agents = yield* AgentV2.Service
  const tools = yield* ToolRegistry.Service
  const models = yield* SessionRunnerModel.Service
  const store = yield* SessionStore.Service
  const location = yield* Location.Service
  const systemContext = yield* SystemContextRegistry.Service
  const skillGuidance = yield* SkillGuidance.Service
  const config = yield* Config.Service
  const db = (yield* Database.Service).db
  const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })

  const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
    const session = yield* store.get(sessionID)
    if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
    return session
  })
  const stale = Symbol("stale turn preparation")
  const retryAgentMismatch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchDefect((defect) =>
        defect instanceof SessionContextEpoch.AgentMismatch ? Effect.succeed(stale) : Effect.die(defect),
      ),
    )
  const loadSystemContext = (agent: AgentV2.Selection) =>
    Effect.all([systemContext.load(), skillGuidance.load(agent)], { concurrency: "unbounded" }).pipe(
      Effect.map(SystemContext.combine),
    )
  const promoteDelivery = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, delivery: SessionInput.Delivery) {
    const cutoff = yield* SessionInput.latestSeq(db, sessionID)
    if (delivery === "queue") yield* SessionInput.promoteNextQueued(db, events, sessionID)
    yield* SessionInput.promoteSteers(db, events, sessionID, cutoff)
  })

  /**
   * Builds the next model request from durable Session state.
   *
   * Initial instructions must be available before admitted input becomes visible.
   * Once input is promoted, retries load it from history instead of promoting
   * again. This matters for queued input because promotion opens the next item.
   */
  const buildRequest = Effect.fn("SessionRunner.buildRequest")(function* (
    sessionID: SessionSchema.ID,
    delivery: SessionInput.Delivery | undefined,
  ) {
    let pendingDelivery = delivery
    while (true) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const initialized = yield* retryAgentMismatch(
        SessionContextEpoch.initialize(db, loadSystemContext(agent), session.id, session.location, agent.id),
      )
      if (initialized === stale) continue
      if (pendingDelivery) {
        yield* promoteDelivery(session.id, pendingDelivery)
        pendingDelivery = undefined
      }
      const prepared =
        initialized ??
        (yield* retryAgentMismatch(
          SessionContextEpoch.prepare(db, events, loadSystemContext(agent), session.id, session.location, agent.id),
        ))
      if (prepared === stale) continue
      const system = prepared
      const model = yield* models.resolve(session)
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const toolMaterialization = yield* tools.materialize(agent.info?.permissions)
      const request = LLM.request({
        model,
        providerOptions: {
          openai: { promptCacheKey: /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id },
        },
        system: [agent.info?.system, system.baseline]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: toLLMMessages(
          entries.map((entry) => entry.message),
          model,
        ),
        tools: toolMaterialization.definitions,
      })
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request })) {
        continue
      }
      if (!(yield* SessionContextEpoch.current(db, session.id, agent.id, system.revision))) {
        continue
      }
      return { session, agent, model, entries, request, toolMaterialization }
    }
  })

  type RequestSnapshot = Effect.Success<ReturnType<typeof buildRequest>>

  /**
   * Reads one model response and finishes every tool it starts.
   *
   * Provider events and tool results share one permit so durable events stay in
   * order. Tool calls are recorded before their side effects begin. A pre-output
   * overflow is held back so successful compaction does not leave a terminal
   * error in Session history.
   */
  const streamAndSettle = Effect.fn("SessionRunner.streamAndSettle")(function* (
    prepared: RequestSnapshot,
    canRecoverOverflow: boolean,
  ) {
    const publisher = createLLMEventPublisher(events, {
      sessionID: prepared.session.id,
      agent: prepared.agent.id,
      model: {
        id: ModelV2.ID.make(prepared.model.id),
        providerID: ProviderV2.ID.make(prepared.model.provider),
        ...(prepared.session.model?.variant === undefined ? {} : { variant: prepared.session.model.variant }),
      },
    })
    const withPublication = Semaphore.makeUnsafe(1).withPermit
    const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
      withPublication(publisher.publish(event, outputPaths))
    const failUnsettled = (message: string, providerExecuted = false) =>
      withPublication(publisher.failUnsettledTools(message, providerExecuted))
    let needsContinuation = false
    let overflowFailure: ProviderErrorEvent | undefined
    const toolEffect = Effect.fnUntraced(function* (event: Extract<LLMEvent, { readonly type: "tool-call" }>) {
      needsContinuation = true
      const assistantMessageID = yield* publisher.assistantMessageID(event.id)
      return yield* prepared.toolMaterialization
        .settle({
          sessionID: prepared.session.id,
          agent: prepared.agent.id,
          assistantMessageID,
          call: event,
        })
        .pipe(
          Effect.flatMap((settlement) =>
            publish(
              LLMEvent.toolResult({
                id: event.id,
                name: event.name,
                result: settlement.result,
                output: settlement.output,
              }),
              settlement.outputPaths ?? [],
            ),
          ),
        )
    })
    const result = yield* SettleProviderTurn.run({
      stream: (runTool) =>
        llm.stream(prepared.request).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (overflowFailure || publisher.hasProviderError()) return
              if (
                LLMEvent.is.providerError(event) &&
                isContextOverflowFailure(event) &&
                !publisher.hasAssistantStarted()
              ) {
                overflowFailure = event
                return
              }
              yield* publish(event)
              if (event.type !== "tool-call" || event.providerExecuted) return
              yield* runTool(toolEffect(event))
            }),
          ),
          Effect.ensuring(withPublication(publisher.flush())),
        ),
      recoverOverflow: (failure, restore) =>
        Effect.gen(function* () {
          if (!canRecoverOverflow || publisher.hasAssistantStarted()) return false
          if (!isContextOverflowFailure(overflowFailure ?? failure)) return false
          return yield* restore(
            compaction.compactAfterOverflow({
              sessionID: prepared.session.id,
              entries: prepared.entries,
              model: prepared.model,
              request: prepared.request,
            }),
          )
        }),
      projectProviderFailure: (failure) =>
        Effect.gen(function* () {
          if (overflowFailure) yield* publish(overflowFailure)
          if (failure instanceof LLMError && !publisher.hasProviderError()) {
            yield* failUnsettled("Provider did not return a tool result", true)
            yield* withPublication(
              events.publish(SessionEvent.Step.Failed, {
                sessionID: prepared.session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                error: { type: "unknown", message: failure.reason.message },
              }),
            )
          }
        }),
      hasProviderError: publisher.hasProviderError,
      failUnsettled,
    })
    return SettleProviderTurn.Result.match<typeof AttemptResult.Type>(result, {
      RecoveredOverflow: () => AttemptResult.cases.CompactedOverflow.make({}),
      Complete: () =>
        AttemptResult.cases.Complete.make({
          needsContinuation: !publisher.hasProviderError() && needsContinuation,
        }),
    })
  }, Effect.scoped)

  const run = Effect.fn("SessionRunner.runTurn")(function* (input: Input): Effect.fn.Return<boolean, RunError> {
    let pendingDelivery = input.delivery
    let canRecoverOverflow = true
    while (true) {
      const request = yield* buildRequest(input.sessionID, pendingDelivery)
      pendingDelivery = undefined
      const result = yield* streamAndSettle(request, canRecoverOverflow)
      const next = AttemptResult.match(result, {
        Complete: (completed) => completed.needsContinuation,
        CompactedOverflow: () => undefined,
      })
      if (next !== undefined) return next
      canRecoverOverflow = false
    }
  })

  return run
})
