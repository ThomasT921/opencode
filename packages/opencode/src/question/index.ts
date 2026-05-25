import { Cache, Context, Deferred, Duration, Effect, Layer, Schema } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { SessionID, MessageID } from "@/session/schema"
import * as Log from "@opencode-ai/core/util/log"
import { QuestionID } from "./schema"

const log = Log.create({ service: "question" })

// Schemas — these are pure data; nothing checks class identity (see PR
// description) so they're plain `Schema.Struct` + type alias. That lets
// `Question.ask` and other internal sites trust the type contract without a
// re-decode to coerce nested class instances.

export const Option = Schema.Struct({
  label: Schema.String.annotate({
    description: "Display text (1-5 words, concise)",
  }),
  description: Schema.String.annotate({
    description: "Explanation of choice",
  }),
}).annotate({ identifier: "QuestionOption" })
export type Option = Schema.Schema.Type<typeof Option>

const base = {
  question: Schema.String.annotate({
    description: "Complete question",
  }),
  header: Schema.String.annotate({
    description: "Very short label (max 30 chars)",
  }),
  options: Schema.Array(Option).annotate({
    description: "Available choices",
  }),
  multiple: Schema.optional(Schema.Boolean).annotate({
    description: "Allow selecting multiple choices",
  }),
}

export const Info = Schema.Struct({
  ...base,
  custom: Schema.optional(Schema.Boolean).annotate({
    description: "Allow typing a custom answer (default: true)",
  }),
}).annotate({ identifier: "QuestionInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const Prompt = Schema.Struct(base).annotate({ identifier: "QuestionPrompt" })
export type Prompt = Schema.Schema.Type<typeof Prompt>

export const Tool = Schema.Struct({
  messageID: MessageID,
  callID: Schema.String,
}).annotate({ identifier: "QuestionTool" })
export type Tool = Schema.Schema.Type<typeof Tool>

export const Request = Schema.Struct({
  id: QuestionID,
  sessionID: SessionID,
  questions: Schema.Array(Info).annotate({
    description: "Questions to ask",
  }),
  tool: Schema.optional(Tool),
}).annotate({ identifier: "QuestionRequest" })
export type Request = Schema.Schema.Type<typeof Request>

export const Answer = Schema.Array(Schema.String).annotate({ identifier: "QuestionAnswer" })
export type Answer = Schema.Schema.Type<typeof Answer>

export const Reply = Schema.Struct({
  answers: Schema.Array(Answer).annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
}).annotate({ identifier: "QuestionReply" })
export type Reply = Schema.Schema.Type<typeof Reply>

export const Result = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("answered"),
    answers: Schema.Array(Answer).annotate({
      description: "User answers in order of questions (each answer is an array of selected labels)",
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("rejected"),
  }),
]).annotate({ discriminator: "status", identifier: "QuestionResult" })
export type Result = Schema.Schema.Type<typeof Result>

const Replied = Schema.Struct({
  sessionID: SessionID,
  requestID: QuestionID,
  answers: Schema.Array(Answer),
}).annotate({ identifier: "QuestionReplied" })

const Rejected = Schema.Struct({
  sessionID: SessionID,
  requestID: QuestionID,
}).annotate({ identifier: "QuestionRejected" })

export const Event = {
  Asked: BusEvent.define("question.asked", Request),
  Replied: BusEvent.define("question.replied", Replied),
  Rejected: BusEvent.define("question.rejected", Rejected),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Question.NotFoundError", {
  requestID: QuestionID,
}) {}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<Result>
}

interface State {
  pending: Map<QuestionID, PendingEntry>
  completed: Cache.Cache<QuestionID, Result, NotFoundError>
}

// Service

export interface Interface {
  readonly create: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<Request>
  readonly ask: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly wait: (requestID: QuestionID) => Effect.Effect<Result, NotFoundError>
  readonly reply: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
  }) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: QuestionID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Question") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Question.state")(function* () {
        const state = {
          pending: new Map<QuestionID, PendingEntry>(),
          completed: yield* Cache.make<QuestionID, Result, NotFoundError>({
            capacity: 10_000,
            timeToLive: Duration.minutes(30),
            lookup: (requestID) => Effect.fail(new NotFoundError({ requestID })),
          }),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.succeed(item.deferred, { status: "rejected" })
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const create = Effect.fn("Question.create")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const id = QuestionID.ascending()
      log.info("asking", { id, questions: input.questions.length })

      const deferred = yield* Deferred.make<Result>()
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }
      pending.set(id, { info, deferred })
      yield* bus.publish(Event.Asked, info)
      return info
    })

    const wait = Effect.fn("Question.wait")(function* (requestID: QuestionID) {
      const info = yield* InstanceState.get(state)
      const pending = info.pending.get(requestID)
      if (pending) return yield* Deferred.await(pending.deferred)
      return yield* Cache.get(info.completed, requestID).pipe(
        Effect.tapError(() => Cache.invalidateWhen(info.completed, requestID, () => true)),
      )
    })

    const ask = Effect.fn("Question.ask")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
    }) {
      const request = yield* create(input)

      const result = yield* Effect.ensuring(
        wait(request.id).pipe(Effect.orDie),
        Effect.gen(function* () {
          const info = yield* InstanceState.get(state)
          info.pending.delete(request.id)
        }),
      )
      if (result.status === "answered") return result.answers
      return yield* new RejectedError()
    })

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const info = yield* InstanceState.get(state)
      const existing = info.pending.get(input.requestID)
      if (!existing) {
        log.warn("reply for unknown request", { requestID: input.requestID })
        return yield* new NotFoundError({ requestID: input.requestID })
      }
      const result: Result = {
        status: "answered",
        answers: input.answers.map((a) => [...a]),
      }
      yield* Cache.set(info.completed, input.requestID, result)
      info.pending.delete(input.requestID)
      log.info("replied", { requestID: input.requestID, answers: input.answers })
      yield* bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        answers: result.answers,
      })
      yield* Deferred.succeed(existing.deferred, result)
    })

    const reject = Effect.fn("Question.reject")(function* (requestID: QuestionID) {
      const info = yield* InstanceState.get(state)
      const existing = info.pending.get(requestID)
      if (!existing) {
        log.warn("reject for unknown request", { requestID })
        return yield* new NotFoundError({ requestID })
      }
      yield* Cache.set(info.completed, requestID, { status: "rejected" })
      info.pending.delete(requestID)
      log.info("rejected", { requestID })
      yield* bus.publish(Event.Rejected, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
      })
      yield* Deferred.succeed(existing.deferred, { status: "rejected" })
    })

    const list = Effect.fn("Question.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (x) => x.info)
    })

    return Service.of({ create, ask, wait, reply, reject, list })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Question from "."
