export * as RunTurn from "./run-turn"

import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { Cause, DateTime, Effect, FiberSet, Option, Schema, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SkillGuidance } from "../../skill/guidance"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { ToolOutputStore } from "../../tool-output-store"
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
import { toLLMMessages } from "./to-llm-message"

export type Run = (
  sessionID: SessionSchema.ID,
  promotion: SessionInput.Delivery | undefined,
) => Effect.Effect<boolean, RunError>

type TurnTransition =
  | { readonly _tag: "RebuildPreparedTurn"; readonly promotion?: SessionInput.Delivery }
  | { readonly _tag: "ContinueAfterOverflowCompaction" }

class TurnTransitionError extends Error {
  constructor(readonly transition: TurnTransition) {
    super()
  }
}

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
  const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
    Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))
  const isQuestionRejected = (cause: Cause.Cause<unknown>) =>
    cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof QuestionV2.RejectedError)
  const rebuildPreparedTurn = (promotion?: SessionInput.Delivery) =>
    new TurnTransitionError({ _tag: "RebuildPreparedTurn", promotion })
  const continueAfterOverflowCompaction = new TurnTransitionError({
    _tag: "ContinueAfterOverflowCompaction",
  })
  const retryAgentMismatch = (promotion: SessionInput.Delivery | undefined) =>
    Effect.catchDefect((defect) =>
      defect instanceof SessionContextEpoch.AgentMismatch
        ? Effect.die(rebuildPreparedTurn(promotion))
        : Effect.die(defect),
    )
  const sameModel = Schema.toEquivalence(Schema.UndefinedOr(ModelV2.Ref))
  const loadSystemContext = (agent: AgentV2.Selection) =>
    Effect.all([systemContext.load(), skillGuidance.load(agent)], { concurrency: "unbounded" }).pipe(
      Effect.map(SystemContext.combine),
    )

  const runAttempt = Effect.fn("SessionRunner.runTurn")(function* (
    sessionID: SessionSchema.ID,
    promotion: SessionInput.Delivery | undefined,
    recoverOverflow?: typeof compaction.compactAfterOverflow,
  ) {
    const session = yield* getSession(sessionID)
    if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
      return yield* Effect.interrupt
    const agent = yield* agents.select(session.agent)
    const initialized = yield* SessionContextEpoch.initialize(
      db,
      loadSystemContext(agent),
      session.id,
      session.location,
      agent.id,
    ).pipe(retryAgentMismatch(promotion))
    const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
    let needsContinuation = false
    if (promotion) {
      const cutoff = yield* SessionInput.latestSeq(db, session.id)
      if (promotion === "steer") yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
      if (promotion === "queue") {
        yield* SessionInput.promoteNextQueued(db, events, session.id)
        yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
      }
    }
    const system =
      initialized ??
      (yield* SessionContextEpoch.prepare(
        db,
        events,
        loadSystemContext(agent),
        session.id,
        session.location,
        agent.id,
      ).pipe(retryAgentMismatch(undefined)))
    const current = yield* getSession(sessionID)
    if ((yield* agents.select(current.agent)).id !== agent.id || !sameModel(current.model, session.model))
      return yield* Effect.die(rebuildPreparedTurn())
    const model = yield* models.resolve(session)
    const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
    const context = entries.map((entry) => entry.message)
    const toolMaterialization = yield* tools.materialize(agent.info?.permissions)
    const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
    const request = LLM.request({
      model,
      providerOptions: { openai: { promptCacheKey } },
      system: [agent.info?.system, system.baseline]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .map(SystemPart.make),
      messages: toLLMMessages(context, model),
      tools: toolMaterialization.definitions,
    })
    if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request }))
      return yield* Effect.die(rebuildPreparedTurn())
    const publisher = createLLMEventPublisher(events, {
      sessionID: session.id,
      agent: agent.id,
      model: {
        id: ModelV2.ID.make(model.id),
        providerID: ProviderV2.ID.make(model.provider),
        ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
      },
    })
    const withPublication = Semaphore.makeUnsafe(1).withPermit
    const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
      withPublication(publisher.publish(event, outputPaths))
    let overflowFailure: ProviderErrorEvent | undefined
    if (!(yield* SessionContextEpoch.current(db, session.id, agent.id, system.revision)))
      return yield* Effect.die(rebuildPreparedTurn())
    const providerStream = llm.stream(request).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (overflowFailure || publisher.hasProviderError()) return
          if (LLMEvent.is.providerError(event)) {
            if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
              overflowFailure = event
              return
            }
          }
          yield* publish(event)
          if (event.type !== "tool-call" || event.providerExecuted) return
          needsContinuation = true
          const assistantMessageID = yield* publisher.assistantMessageID(event.id)
          yield* Effect.uninterruptibleMask((restore) =>
            restore(
              toolMaterialization.settle({
                sessionID: session.id,
                agent: agent.id,
                assistantMessageID,
                call: event,
              }),
            ).pipe(
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
            ),
          ).pipe(FiberSet.run(toolFibers))
        }),
      ),
      Effect.ensuring(withPublication(publisher.flush())),
    )

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const stream = yield* restore(providerStream).pipe(Effect.exit)
        const failure =
          stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
        if (
          recoverOverflow &&
          !publisher.hasAssistantStarted() &&
          isContextOverflowFailure(overflowFailure ?? failure) &&
          (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request })))
        )
          return yield* Effect.die(continueAfterOverflowCompaction)
        if (overflowFailure) yield* publish(overflowFailure)
        const llmFailure = failure instanceof LLMError ? failure : undefined
        if (llmFailure && !publisher.hasProviderError()) {
          yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          yield* withPublication(
            events.publish(SessionEvent.Step.Failed, {
              sessionID: session.id,
              timestamp: yield* DateTime.now,
              assistantMessageID: yield* publisher.startAssistant(),
              error: { type: "unknown", message: llmFailure.reason.message },
            }),
          )
        }
        if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
        const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
        if (settled._tag === "Failure" && isQuestionRejected(settled.cause)) {
          yield* FiberSet.clear(toolFibers)
          yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          return yield* Effect.interrupt
        }
        if (
          (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
          (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
        ) {
          yield* FiberSet.clear(toolFibers)
          yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
        }
        if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
          const failure = Cause.squash(settled.cause)
          const message = failure instanceof Error ? failure.message : String(failure)
          yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
        }
        if (publisher.hasProviderError())
          yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
        if (stream._tag === "Success" && !publisher.hasProviderError())
          yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
        if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
        if (settled._tag === "Failure") return yield* Effect.failCause(settled.cause)
        return !publisher.hasProviderError() && needsContinuation
      }),
    )
  }, Effect.scoped)

  const runAfterOverflowCompaction: Run = Effect.fnUntraced(function* (sessionID, promotion) {
    return yield* runAttempt(sessionID, promotion).pipe(
      Effect.catchDefect(
        Effect.fnUntraced(function* (defect) {
          if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
          if (defect.transition._tag === "ContinueAfterOverflowCompaction")
            return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
          yield* Effect.yieldNow
          return yield* runAfterOverflowCompaction(sessionID, defect.transition.promotion)
        }),
      ),
    )
  })

  const run: Run = Effect.fnUntraced(function* (sessionID, promotion) {
    return yield* runAttempt(sessionID, promotion, compaction.compactAfterOverflow).pipe(
      Effect.catchDefect(
        Effect.fnUntraced(function* (defect) {
          if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
          yield* Effect.yieldNow
          if (defect.transition._tag === "ContinueAfterOverflowCompaction")
            return yield* runAfterOverflowCompaction(sessionID, undefined)
          return yield* run(sessionID, defect.transition.promotion)
        }),
      ),
    )
  })

  return run
})
