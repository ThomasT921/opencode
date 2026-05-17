import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { simulateReadableStream } from "ai"
import { Effect, Layer } from "effect"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { SimulationDebugLog } from "./debug-log"
import { Simulation, type LLMScript } from "./service"

const providerID = ProviderID.make("simulation")
const modelID = ModelID.make("mock")

const model: Provider.Model = {
  id: modelID,
  providerID,
  api: { id: modelID, url: "simulation://mock", npm: "simulation" },
  name: "Simulation Mock",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants: {},
}

const provider: Provider.Info = {
  id: providerID,
  name: "Simulation",
  source: "custom",
  env: [],
  options: {},
  models: { [modelID]: model },
}

const defaultScript: LLMScript = {
  steps: [[{ type: "text", content: "Simulation mock response." }]],
  finish: "stop",
}

function nextScript(simulation: Simulation.Interface) {
  return Effect.runPromise(simulation.nextLLM().pipe(Effect.catch(() => Effect.succeed(defaultScript))))
}

function text(script: LLMScript) {
  return script.steps[0]?.flatMap((item) => (item.type === "text" || item.type === "thinking" ? [item.content] : []))
    .join("") ?? ""
}

function error(script: LLMScript) {
  return script.steps[0]?.find((item) => item.type === "error")
}

function stream(script: LLMScript) {
  const chunks: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }]
  for (const [index, item] of (script.steps[0] ?? []).entries()) {
    if (item.type === "error") {
      chunks.push({ type: "error", error: new Error(item.message) })
      continue
    }
    const id = `simulation-${item.type}-${index + 1}`
    if (item.type === "thinking") {
      chunks.push(
        { type: "reasoning-start", id },
        { type: "reasoning-delta", id, delta: item.content },
        { type: "reasoning-end", id },
      )
      continue
    }
    if (item.type === "tool-call") {
      const input = JSON.stringify(item.input)
      chunks.push(
        { type: "tool-input-start", id: item.toolCallId, toolName: item.toolName },
        { type: "tool-input-delta", id: item.toolCallId, delta: input },
        { type: "tool-input-end", id: item.toolCallId },
        { type: "tool-call", toolCallId: item.toolCallId, toolName: item.toolName, input },
      )
      continue
    }
    chunks.push(
      { type: "text-start", id },
      { type: "text-delta", id, delta: item.content },
      { type: "text-end", id },
    )
  }
  chunks.push({ type: "finish", finishReason: finishReason(script), usage: usage(script) })
  SimulationDebugLog.write("provider.stream.chunks", { chunks: chunks.map((chunk) => chunk.type) })

  return simulateReadableStream({
    chunks,
    initialDelayInMs: 0,
    chunkDelayInMs: 0,
  })
}

function usage(script: LLMScript) {
  return {
    inputTokens: {
      total: script.usage?.inputTokens ?? 0,
      noCache: script.usage?.inputTokens ?? 0,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: script.usage?.outputTokens ?? text(script).length,
      text: script.usage?.outputTokens ?? text(script).length,
      reasoning: undefined,
    },
    raw: script.usage,
  }
}

function finishReason(script: LLMScript): LanguageModelV3FinishReason {
  return { unified: script.finish === "unknown" ? "other" : (script.finish ?? "stop"), raw: script.finish }
}

function language(simulation: Simulation.Interface): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "simulation",
    modelId: modelID,
    supportedUrls: {},
    async doGenerate(_options: LanguageModelV3CallOptions) {
      const script = await nextScript(simulation)
      const err = error(script)
      if (err?.type === "error") throw new Error(err.message)
      const content: LanguageModelV3Content[] = []
      const textValue = text(script)
      if (textValue) content.push({ type: "text", text: textValue })
      for (const item of script.steps[0] ?? []) {
        if (item.type !== "tool-call") continue
        content.push({
          type: "tool-call",
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          input: JSON.stringify(item.input),
        })
      }
      return {
        content,
        finishReason: finishReason(script),
        usage: usage(script),
        warnings: [],
      }
    },
    async doStream(_options: LanguageModelV3CallOptions) {
      SimulationDebugLog.write("provider.doStream.start")
      const script = await nextScript(simulation)
      SimulationDebugLog.write("provider.doStream.script", { steps: script.steps.map((step) => step.map((item) => item.type)) })
      return { stream: stream(script) }
    },
  }
}

export const layer = Layer.effect(
  Provider.Service,
  Effect.gen(function* () {
    const simulation = yield* Simulation.Service
    const lang = language(simulation)
    return Provider.Service.of({
      list: () => Effect.succeed({ [providerID]: provider }),
      getProvider: () => Effect.succeed(provider),
      getModel: () => Effect.succeed(model),
      getLanguage: () => Effect.succeed(lang),
      closest: () => Effect.succeed({ providerID, modelID }),
      getSmallModel: () => Effect.succeed(model),
      defaultModel: () => Effect.succeed({ providerID, modelID }),
    })
  }),
)

export * as SimulationProvider from "./provider"
