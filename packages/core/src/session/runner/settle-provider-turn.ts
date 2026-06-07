export * as SettleProviderTurn from "./settle-provider-turn"

import { Cause, Effect, FiberSet, Option, Schema } from "effect"
import { QuestionV2 } from "../../question"
import { ToolOutputStore } from "../../tool-output-store"

export const Result = Schema.TaggedUnion({
  Complete: {},
  RecoveredOverflow: {},
})

const isQuestionRejected = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof QuestionV2.RejectedError)

const awaitTools = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
  Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

/**
 * Runs one provider response together with every local tool it starts.
 *
 * The provider and tools remain interruptible. Once the provider stops, cleanup
 * cannot be interrupted before every started tool is observed, cancelled, or
 * settled and its original failure is propagated.
 */
export const run = Effect.fn("SessionRunner.settleProviderTurn")(function* <E, R, E2, R2, E3, R3>(input: {
  readonly stream: (
    runTool: (effect: Effect.Effect<void, ToolOutputStore.Error>) => Effect.Effect<void>,
  ) => Effect.Effect<void, E, R>
  readonly recoverOverflow: (
    failure: unknown,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<boolean, E2, R2>
  readonly projectProviderFailure: (failure: unknown) => Effect.Effect<void, E3, R3>
  readonly hasProviderError: () => boolean
  readonly failUnsettled: (message: string, providerExecuted?: boolean) => Effect.Effect<void>
}) {
  const tools = yield* FiberSet.make<void, ToolOutputStore.Error>()
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const stream = yield* restore(input.stream((effect) => effect.pipe(FiberSet.run(tools)))).pipe(Effect.exit)
      const failure = stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
      if (yield* input.recoverOverflow(failure, restore)) return Result.cases.RecoveredOverflow.make({})

      yield* input.projectProviderFailure(failure)
      const streamInterrupted = stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)
      if (streamInterrupted) yield* FiberSet.clear(tools)
      const settled = yield* restore(awaitTools(tools)).pipe(Effect.exit)
      if (settled._tag === "Failure" && isQuestionRejected(settled.cause)) {
        yield* FiberSet.clear(tools)
        yield* input.failUnsettled("Tool execution interrupted")
        return yield* Effect.interrupt
      }

      const toolInterrupted = settled._tag === "Failure" && Cause.hasInterrupts(settled.cause)
      if (toolInterrupted) yield* FiberSet.clear(tools)
      if (streamInterrupted || toolInterrupted || input.hasProviderError())
        yield* input.failUnsettled("Tool execution interrupted")
      if (settled._tag === "Failure" && !toolInterrupted) {
        const failure = Cause.squash(settled.cause)
        yield* input.failUnsettled(
          `Tool execution failed: ${failure instanceof Error ? failure.message : String(failure)}`,
        )
      }
      if (stream._tag === "Success" && !input.hasProviderError())
        yield* input.failUnsettled("Provider did not return a tool result", true)
      if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
      if (settled._tag === "Failure") return yield* Effect.failCause(settled.cause)
      return Result.cases.Complete.make({})
    }),
  )
}, Effect.scoped)
