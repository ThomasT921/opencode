import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import path from "path"
import { SimulationNetwork } from "./network"

export const FileContent = Schema.Union([
  Schema.String,
  Schema.Struct({ encoding: Schema.Literal("base64"), data: Schema.String }),
])

export const FilesystemSeedInput = Schema.Struct({
  files: Schema.Record(Schema.String, FileContent),
})

export const FilesystemWriteInput = Schema.Struct({
  path: Schema.String,
  content: FileContent,
})

export const NetworkRegisterInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("json"),
    url: Schema.String,
    method: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Number),
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    body: Schema.Json,
  }),
  Schema.Struct({
    kind: Schema.Literal("text"),
    url: Schema.String,
    method: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Number),
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    body: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("status"),
    url: Schema.String,
    method: Schema.optional(Schema.String),
    status: Schema.Number,
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
])

export const LLMScriptAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), content: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking"), content: Schema.String }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool-call"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    input: Schema.Json,
  }),
])

export type LLMScriptAction = typeof LLMScriptAction.Type

export const LLMScript = Schema.Struct({
  steps: Schema.Array(Schema.Array(LLMScriptAction)),
  usage: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.Number,
      outputTokens: Schema.Number,
      totalTokens: Schema.Number,
    }),
  ),
  finish: Schema.optional(Schema.Literals(["stop", "tool-calls", "error", "length", "unknown"])),
})

export type LLMScript = typeof LLMScript.Type

export const LLMEnqueueInput = Schema.Struct({
  scripts: Schema.Array(LLMScript),
})

type FilePath = string

interface State {
  readonly files: readonly FilePath[]
  readonly networkRegistrations: readonly string[]
  readonly llmScripts: readonly LLMScript[]
  readonly consumedLLMScripts: number
}

export class SimulationLLMError extends Schema.TaggedErrorClass<SimulationLLMError>()("SimulationLLMError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly reset: () => Effect.Effect<void>
  readonly seedFilesystem: (input: typeof FilesystemSeedInput.Type) => Effect.Effect<{ files: string[] }, unknown>
  readonly writeFile: (input: typeof FilesystemWriteInput.Type) => Effect.Effect<{ file: string }, unknown>
  readonly registerNetwork: (input: typeof NetworkRegisterInput.Type) => Effect.Effect<{ registered: string }, unknown>
  readonly enqueueLLM: (input: typeof LLMEnqueueInput.Type) => Effect.Effect<{ queued: number }>
  readonly nextLLM: () => Effect.Effect<LLMScript, SimulationLLMError>
  readonly snapshot: () => Effect.Effect<{
    files: readonly string[]
    networkRegistrations: readonly string[]
    llmQueued: number
    llmConsumed: number
    network: SimulationNetwork.Snapshot
  }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Simulation") {}

function fileContent(content: typeof FileContent.Type) {
  if (typeof content === "string") return content
  return Uint8Array.from(Buffer.from(content.data, "base64"))
}

function matcher(input: typeof NetworkRegisterInput.Type) {
  return input.method ? { method: input.method, url: input.url } : input.url
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const network = yield* SimulationNetwork.Service
    const empty: State = {
      files: [],
      networkRegistrations: [],
      llmScripts: [],
      consumedLLMScripts: 0,
    }
    const state = yield* Ref.make<State>(empty)

    const reset = Effect.fn("Simulation.reset")(function* () {
      yield* network.reset()
      yield* Ref.set(state, empty)
    })

    const seedFilesystem = Effect.fn("Simulation.seedFilesystem")(function* (input: typeof FilesystemSeedInput.Type) {
      const files = Object.keys(input.files)
      yield* Effect.forEach(
        Object.entries(input.files),
        ([file, content]) => fs.writeWithDirs(path.isAbsolute(file) ? file : path.join("/opencode", file), fileContent(content)),
      )
      yield* Ref.update(state, (current) => ({ ...current, files: [...current.files, ...files] }))
      return { files }
    })

    const writeFile = Effect.fn("Simulation.writeFile")(function* (input: typeof FilesystemWriteInput.Type) {
      yield* fs.writeWithDirs(path.isAbsolute(input.path) ? input.path : path.join("/opencode", input.path), fileContent(input.content))
      yield* Ref.update(state, (current) => ({ ...current, files: [...current.files, input.path] }))
      return { file: input.path }
    })

    const registerNetwork = Effect.fn("Simulation.registerNetwork")(function* (input: typeof NetworkRegisterInput.Type) {
      switch (input.kind) {
        case "json":
          yield* network.register(
            SimulationNetwork.json(matcher(input), input.body, { status: input.status, headers: input.headers }),
          )
          break
        case "text":
          yield* network.register(
            SimulationNetwork.text(matcher(input), input.body, { status: input.status, headers: input.headers }),
          )
          break
        case "status":
          yield* network.register(SimulationNetwork.status(matcher(input), input.status, { headers: input.headers }))
          break
      }
      yield* Ref.update(state, (current) => ({
        ...current,
        networkRegistrations: [...current.networkRegistrations, `${input.method ?? "*"} ${input.url}`],
      }))
      return { registered: input.url }
    })

    const enqueueLLM = Effect.fn("Simulation.enqueueLLM")(function* (input: typeof LLMEnqueueInput.Type) {
      yield* Ref.update(state, (current) => ({ ...current, llmScripts: [...current.llmScripts, ...input.scripts] }))
      return { queued: input.scripts.length }
    })

    const nextLLM = Effect.fn("Simulation.nextLLM")(function* () {
      const current = yield* Ref.get(state)
      const [script, ...rest] = current.llmScripts
      if (!script) return yield* new SimulationLLMError({ message: "No LLM script queued" })
      yield* Ref.set(state, { ...current, llmScripts: rest, consumedLLMScripts: current.consumedLLMScripts + 1 })
      return script
    })

    const snapshot = Effect.fn("Simulation.snapshot")(function* () {
      const current = yield* Ref.get(state)
      return {
        files: current.files,
        networkRegistrations: current.networkRegistrations,
        llmQueued: current.llmScripts.length,
        llmConsumed: current.consumedLLMScripts,
        network: yield* network.snapshot(),
      }
    })

    return Service.of({ reset, seedFilesystem, writeFile, registerNetwork, enqueueLLM, nextLLM, snapshot })
  }),
)

export * as Simulation from "./service"
