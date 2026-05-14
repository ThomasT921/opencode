import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { SimulationNetwork, type RequestInfo } from "../../../src/testing/simulation/network"
import { testEffect } from "../../lib/effect"

const it = testEffect(
  SimulationNetwork.layer({
    allowLoopback: false,
    entries: [
      SimulationNetwork.json("https://models.dev/api.json", { openai: { id: "openai" } }),
      SimulationNetwork.text("https://example.com/page", "hello"),
      SimulationNetwork.json(/https:\/\/example\.com\/dynamic/, (request: RequestInfo) => ({
        method: request.method,
        query: request.url.searchParams.get("q"),
      })),
      SimulationNetwork.text(/https:\/\/example\.com\/echo-text/, (request: RequestInfo) =>
        `text:${request.method}:${request.url.searchParams.get("value")}`,
      ),
      SimulationNetwork.bytes(/https:\/\/example\.com\/echo-bytes/, (request: RequestInfo) =>
        new TextEncoder().encode(`bytes:${request.url.searchParams.get("value")}`),
      ),
    ],
  }),
)

describe("SimulationNetwork", () => {
  it.effect("serves registered JSON responses", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const response = yield* http.execute(HttpClientRequest.get("https://models.dev/api.json"))

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ openai: { id: "openai" } })
    }),
  )

  it.effect("serves registered text responses", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const response = yield* http.execute(HttpClientRequest.get("https://example.com/page"))

      expect(response.headers["content-type"]).toContain("text/plain")
      expect(yield* response.text).toBe("hello")
    }),
  )

  it.effect("fails unknown external URLs", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const exit = yield* http.execute(HttpClientRequest.get("https://api.openai.com/v1/models")).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("serves dynamic request-based responses", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const response = yield* http.execute(HttpClientRequest.post("https://example.com/dynamic?q=test"))

      expect(yield* response.json).toEqual({ method: "POST", query: "test" })
    }),
  )

  it.effect("serves dynamic text responses", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const response = yield* http.execute(HttpClientRequest.put("https://example.com/echo-text?value=hello"))

      expect(yield* response.text).toBe("text:PUT:hello")
    }),
  )

  it.effect("serves dynamic byte responses", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const response = yield* http.execute(HttpClientRequest.get("https://example.com/echo-bytes?value=hello"))

      expect(new TextDecoder().decode(yield* response.arrayBuffer)).toBe("bytes:hello")
    }),
  )

  it.effect("can register responses after layer startup", () =>
    Effect.gen(function* () {
      const network = yield* SimulationNetwork.Service
      const http = yield* HttpClient.HttpClient

      yield* network.register(SimulationNetwork.status("https://opencode.ai/ping", 204))

      const response = yield* http.execute(HttpClientRequest.get("https://opencode.ai/ping"))
      expect(response.status).toBe(204)
    }),
  )

  it.effect("can register dynamic responses after layer startup", () =>
    Effect.gen(function* () {
      const network = yield* SimulationNetwork.Service
      const http = yield* HttpClient.HttpClient

      yield* network.register(
        SimulationNetwork.json("https://opencode.ai/runtime", (request: RequestInfo) => ({
          host: request.url.hostname,
          header: request.headers["x-test"],
        })),
      )

      const response = yield* http.execute(
        HttpClientRequest.get("https://opencode.ai/runtime").pipe(HttpClientRequest.setHeader("x-test", "ok")),
      )
      expect(yield* response.json).toEqual({ host: "opencode.ai", header: "ok" })
    }),
  )
})
