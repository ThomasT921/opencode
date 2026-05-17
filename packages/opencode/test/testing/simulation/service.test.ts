import { describe, expect } from "bun:test"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { streamText, tool, jsonSchema } from "ai"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Provider } from "../../../src/provider/provider"
import { SimulationFileSystem } from "../../../src/testing/simulation/filesystem"
import { SimulationNetwork } from "../../../src/testing/simulation/network"
import { SimulationProvider } from "../../../src/testing/simulation/provider"
import { Simulation } from "../../../src/testing/simulation/service"
import { testEffect } from "../../lib/effect"

const fsLayer = SimulationFileSystem.layer({ root: "/opencode" })
const networkLayer = SimulationNetwork.layer({ allowLoopback: false })
const simulationLayer = Simulation.layer.pipe(Layer.provide(fsLayer), Layer.provide(networkLayer))
const providerLayer = SimulationProvider.layer.pipe(Layer.provide(simulationLayer))
const it = testEffect(Layer.mergeAll(fsLayer, networkLayer, simulationLayer, providerLayer))

describe("Simulation", () => {
  it.effect("seeds files into the simulated filesystem", () =>
    Effect.gen(function* () {
      const simulation = yield* Simulation.Service
      const fs = yield* AppFileSystem.Service

      expect(yield* simulation.seedFilesystem({ files: { "opencode.json": "{}" } })).toEqual({
        files: ["opencode.json"],
      })
      expect(yield* fs.readFileString("/opencode/opencode.json")).toBe("{}")
    }),
  )

  it.effect("writes one file into the simulated filesystem", () =>
    Effect.gen(function* () {
      const simulation = yield* Simulation.Service
      const fs = yield* AppFileSystem.Service

      expect(yield* simulation.writeFile({ path: "src/generated.txt", content: "generated" })).toEqual({ file: "src/generated.txt" })
      expect(yield* fs.readFileString("/opencode/src/generated.txt")).toBe("generated")
      expect((yield* simulation.snapshot()).files).toContain("src/generated.txt")
    }),
  )

  it.effect("registers network responses through control state", () =>
    Effect.gen(function* () {
      const simulation = yield* Simulation.Service
      const http = yield* HttpClient.HttpClient

      expect(
        yield* simulation.registerNetwork({
          kind: "json",
          method: "GET",
          url: "https://example.com/data",
          body: { ok: true },
        }),
      ).toEqual({ registered: "https://example.com/data" })

      const response = yield* http.execute(HttpClientRequest.get("https://example.com/data"))
      expect(yield* response.json).toEqual({ ok: true })
    }),
  )

  it.effect("snapshots and resets simulation state", () =>
    Effect.gen(function* () {
      const simulation = yield* Simulation.Service
      const http = yield* HttpClient.HttpClient

      yield* simulation.seedFilesystem({ files: { "README.md": "hello" } })
      yield* simulation.registerNetwork({ kind: "text", url: "https://example.com/page", body: "hello" })

      const snapshot = yield* simulation.snapshot()
      expect(snapshot.files).toEqual(["README.md"])
      expect(snapshot.networkRegistrations).toEqual(["* https://example.com/page"])
      expect(snapshot.network.routes.some((route) => route.matcher === "https://example.com/page")).toBe(true)

      yield* simulation.reset()

      expect((yield* simulation.snapshot()).files).toEqual([])
      const exit = yield* http.execute(HttpClientRequest.get("https://example.com/page")).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("queues and consumes LLM scripts", () =>
    Effect.gen(function* () {
      const simulation = yield* Simulation.Service

      expect(
        yield* simulation.enqueueLLM({
          scripts: [{ steps: [[{ type: "text", content: "hello" }]], finish: "stop" }],
        }),
      ).toEqual({ queued: 1 })
      expect((yield* simulation.snapshot()).llmQueued).toBe(1)
      expect(yield* simulation.nextLLM()).toEqual({ steps: [[{ type: "text", content: "hello" }]], finish: "stop" })
      expect((yield* simulation.snapshot()).llmConsumed).toBe(1)
    }),
  )

  it.effect("simulation provider consumes queued text scripts", () =>
    Effect.gen(function* () {
      const simulation = yield* Simulation.Service
      const provider = yield* Provider.Service
      const model = yield* provider.defaultModel().pipe(Effect.flatMap((item) => provider.getModel(item.providerID, item.modelID)))
      const language = yield* provider.getLanguage(model)

      yield* simulation.enqueueLLM({ scripts: [{ steps: [[{ type: "text", content: "assistant text" }]] }] })

      const result = yield* Effect.promise(() => language.doGenerate({ prompt: [], abortSignal: undefined }))
      expect(result.content).toEqual([{ type: "text", text: "assistant text" }])
      expect((yield* simulation.snapshot()).llmConsumed).toBe(1)
    }),
  )

  it.effect("simulation provider returns a default response when no script is queued", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.defaultModel().pipe(Effect.flatMap((item) => provider.getModel(item.providerID, item.modelID)))
      const language = yield* provider.getLanguage(model)

      const result = yield* Effect.promise(() => language.doGenerate({ prompt: [], abortSignal: undefined }))
      expect(result.content).toEqual([{ type: "text", text: "Simulation mock response." }])
    }),
  )

  it.effect("simulation provider streams a default response when no script is queued", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.defaultModel().pipe(Effect.flatMap((item) => provider.getModel(item.providerID, item.modelID)))
      const language = yield* provider.getLanguage(model)

      const result = yield* Effect.promise(() => language.doStream({ prompt: [], abortSignal: undefined }))
      const reader = result.stream.getReader()
      const parts: unknown[] = []
      while (true) {
        const next = yield* Effect.promise(() => reader.read())
        if (next.done) break
        parts.push(next.value)
      }

      expect(parts).toContainEqual({ type: "text-delta", id: "simulation-text-1", delta: "Simulation mock response." })
    }),
  )

  it.effect("simulation provider streams queued script actions", () =>
    Effect.gen(function* () {
      const simulation = yield* Simulation.Service
      const provider = yield* Provider.Service
      const model = yield* provider.defaultModel().pipe(Effect.flatMap((item) => provider.getModel(item.providerID, item.modelID)))
      const language = yield* provider.getLanguage(model)

      yield* simulation.enqueueLLM({
        scripts: [
          {
            steps: [
              [
                { type: "thinking", content: "thinking" },
                { type: "text", content: "answer" },
              ],
            ],
          },
        ],
      })

      const result = yield* Effect.promise(() => language.doStream({ prompt: [], abortSignal: undefined }))
      const reader = result.stream.getReader()
      const parts: unknown[] = []
      while (true) {
        const next = yield* Effect.promise(() => reader.read())
        if (next.done) break
        parts.push(next.value)
      }

      expect(parts).toEqual([
        { type: "stream-start", warnings: [] },
        { type: "reasoning-start", id: "simulation-thinking-1" },
        { type: "reasoning-delta", id: "simulation-thinking-1", delta: "thinking" },
        { type: "reasoning-end", id: "simulation-thinking-1" },
        { type: "text-start", id: "simulation-text-2" },
        { type: "text-delta", id: "simulation-text-2", delta: "answer" },
        { type: "text-end", id: "simulation-text-2" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: "thinkinganswer".length, text: "thinkinganswer".length, reasoning: undefined },
            raw: undefined,
          },
        },
      ])
      expect((yield* simulation.snapshot()).llmConsumed).toBe(1)
    }),
  )

  it.effect("simulation provider streams queued tool-call actions", () =>
    Effect.gen(function* () {
      const simulation = yield* Simulation.Service
      const provider = yield* Provider.Service
      const model = yield* provider.defaultModel().pipe(Effect.flatMap((item) => provider.getModel(item.providerID, item.modelID)))
      const language = yield* provider.getLanguage(model)

      yield* simulation.enqueueLLM({
        scripts: [
          {
            steps: [
              [
                { type: "text", content: "I'll write that file for you" },
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "write",
                  input: { filePath: "/opencode/hello.txt", content: "hi" },
                },
              ],
            ],
            finish: "tool-calls",
          },
        ],
      })

      const result = yield* Effect.promise(() => language.doStream({ prompt: [], abortSignal: undefined }))
      const reader = result.stream.getReader()
      const parts: unknown[] = []
      while (true) {
        const next = yield* Effect.promise(() => reader.read())
        if (next.done) break
        parts.push(next.value)
      }

      const expectedInput = JSON.stringify({ filePath: "/opencode/hello.txt", content: "hi" })
      expect(parts).toContainEqual({ type: "tool-input-start", id: "call-1", toolName: "write" })
      expect(parts).toContainEqual({ type: "tool-input-delta", id: "call-1", delta: expectedInput })
      expect(parts).toContainEqual({ type: "tool-input-end", id: "call-1" })
      expect(parts).toContainEqual({ type: "tool-call", toolCallId: "call-1", toolName: "write", input: expectedInput })
      const finish = parts.find((p: any) => p?.type === "finish") as any
      expect(finish?.finishReason).toEqual({ unified: "tool-calls", raw: "tool-calls" })
    }),
  )

  it.effect("simulation provider doGenerate returns tool-call content", () =>
    Effect.gen(function* () {
      const simulation = yield* Simulation.Service
      const provider = yield* Provider.Service
      const model = yield* provider.defaultModel().pipe(Effect.flatMap((item) => provider.getModel(item.providerID, item.modelID)))
      const language = yield* provider.getLanguage(model)

      yield* simulation.enqueueLLM({
        scripts: [
          {
            steps: [
              [
                { type: "text", content: "writing now" },
                {
                  type: "tool-call",
                  toolCallId: "call-9",
                  toolName: "write",
                  input: { filePath: "/opencode/a.txt", content: "x" },
                },
              ],
            ],
            finish: "tool-calls",
          },
        ],
      })

      const result = yield* Effect.promise(() => language.doGenerate({ prompt: [], abortSignal: undefined }))
      expect(result.content).toEqual([
        { type: "text", text: "writing now" },
        {
          type: "tool-call",
          toolCallId: "call-9",
          toolName: "write",
          input: JSON.stringify({ filePath: "/opencode/a.txt", content: "x" }),
        },
      ])
      expect(result.finishReason).toEqual({ unified: "tool-calls", raw: "tool-calls" })
    }),
  )

  it.effect("simulation model advertises toolcall capability", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.defaultModel().pipe(Effect.flatMap((item) => provider.getModel(item.providerID, item.modelID)))
      expect(model.capabilities.toolcall).toBe(true)
    }),
  )

  it.effect("AI SDK streamText invokes tool.execute when the simulated provider emits a tool-call", () =>
    Effect.gen(function* () {
      const simulation = yield* Simulation.Service
      const provider = yield* Provider.Service
      const model = yield* provider.defaultModel().pipe(Effect.flatMap((item) => provider.getModel(item.providerID, item.modelID)))
      const language = yield* provider.getLanguage(model)

      yield* simulation.enqueueLLM({
        scripts: [
          {
            steps: [
              [
                { type: "text", content: "writing now" },
                {
                  type: "tool-call",
                  toolCallId: "call-execute-1",
                  toolName: "write",
                  input: { filePath: "/opencode/from-tool.txt", content: "hello from tool" },
                },
              ],
            ],
            finish: "tool-calls",
          },
        ],
      })

      const executed: Array<{ filePath: string; content: string }> = []
      const result = streamText({
        model: language,
        prompt: "please write the file",
        tools: {
          write: tool({
            description: "Write a file",
            inputSchema: jsonSchema<{ filePath: string; content: string }>({
              type: "object",
              properties: { filePath: { type: "string" }, content: { type: "string" } },
              required: ["filePath", "content"],
            }),
            execute(args) {
              executed.push(args)
              return Promise.resolve({ ok: true, path: args.filePath })
            },
          }),
        },
      })

      // Drain the stream so streamText runs to completion.
      yield* Effect.promise(async () => {
        for await (const _ of result.fullStream) void _
      })

      expect(executed).toEqual([{ filePath: "/opencode/from-tool.txt", content: "hello from tool" }])
    }),
  )
})
