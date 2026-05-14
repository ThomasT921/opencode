import { Context, Effect, Layer, Ref, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http"

type Matcher = string | RegExp | ((request: RequestInfo) => boolean)

export interface RequestInfo {
  readonly method: string
  readonly url: URL
  readonly headers: Readonly<Record<string, string>>
}

export type ResponseEntry =
  | {
      readonly kind: "json"
      readonly matcher: Matcher
      readonly status?: number
      readonly headers?: Readonly<Record<string, string>>
      readonly body: unknown | ((request: RequestInfo) => unknown)
    }
  | {
      readonly kind: "text"
      readonly matcher: Matcher
      readonly status?: number
      readonly headers?: Readonly<Record<string, string>>
      readonly body: string | ((request: RequestInfo) => string)
    }
  | {
      readonly kind: "bytes"
      readonly matcher: Matcher
      readonly status?: number
      readonly headers?: Readonly<Record<string, string>>
      readonly body: Uint8Array | ((request: RequestInfo) => Uint8Array)
    }
  | {
      readonly kind: "status"
      readonly matcher: Matcher
      readonly status: number
      readonly headers?: Readonly<Record<string, string>>
    }

export interface Options {
  readonly entries?: readonly ResponseEntry[]
  readonly allowLoopback?: boolean
}

interface State {
  readonly entries: readonly ResponseEntry[]
  readonly allowLoopback: boolean
}

export class SimulationNetworkError extends Schema.TaggedErrorClass<SimulationNetworkError>()(
  "SimulationNetworkError",
  {
    method: Schema.String,
    url: Schema.String,
    reason: Schema.String,
  },
) {}

export interface Interface {
  readonly register: (entry: ResponseEntry) => Effect.Effect<void>
  readonly handle: (request: RequestInfo) => Effect.Effect<Response, SimulationNetworkError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SimulationNetwork") {}

function matches(matcher: Matcher, request: RequestInfo) {
  if (typeof matcher === "string") return request.url.toString() === matcher
  if (matcher instanceof RegExp) return matcher.test(request.url.toString())
  return matcher(request)
}

function isLoopback(url: URL) {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
}

function headers(input: Readonly<Record<string, string>> | undefined, contentType?: string) {
  return new Headers({ ...(contentType ? { "content-type": contentType } : {}), ...input })
}

function response(entry: ResponseEntry, request: RequestInfo) {
  switch (entry.kind) {
    case "json":
      return new Response(JSON.stringify(typeof entry.body === "function" ? entry.body(request) : entry.body), {
        status: entry.status ?? 200,
        headers: headers(entry.headers, "application/json"),
      })
    case "text":
      return new Response(typeof entry.body === "function" ? entry.body(request) : entry.body, {
        status: entry.status ?? 200,
        headers: headers(entry.headers, "text/plain"),
      })
    case "bytes":
      return new Response((typeof entry.body === "function" ? entry.body(request) : entry.body).slice().buffer, {
        status: entry.status ?? 200,
        headers: headers(entry.headers, "application/octet-stream"),
      })
    case "status":
      return new Response(null, { status: entry.status, headers: headers(entry.headers) })
  }
}

function toRequestInfo(method: string, url: URL, headers: Readonly<Record<string, string>>): RequestInfo {
  return { method, url, headers }
}

function toHttpClientError(request: Parameters<typeof HttpClientResponse.fromWeb>[0], error: SimulationNetworkError) {
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      description: `${error.reason}: ${error.url}`,
    }),
  })
}

export function make(options: Options = {}) {
  return Effect.gen(function* () {
    const state = yield* Ref.make<State>({
      entries: options.entries ?? [],
      allowLoopback: options.allowLoopback ?? true,
    })

    const register = Effect.fn("SimulationNetwork.register")(function* (entry: ResponseEntry) {
      yield* Ref.update(state, (current) => ({ ...current, entries: [...current.entries, entry] }))
    })

    const handle = Effect.fn("SimulationNetwork.handle")(function* (request: RequestInfo) {
      const current = yield* Ref.get(state)
      const entry = current.entries.find((entry) => matches(entry.matcher, request))
      if (entry) return response(entry, request)
      if (current.allowLoopback && isLoopback(request.url)) {
        return yield* Effect.promise(() => fetch(request.url, { method: request.method, headers: request.headers }))
      }
      return yield* new SimulationNetworkError({
        method: request.method,
        url: request.url.toString(),
        reason: "No simulated network response registered",
      })
    })

    return Service.of({ register, handle })
  })
}

export const serviceLayer = (options?: Options) => Layer.effect(Service, make(options))

export const httpClientLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const network = yield* Service
    return HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const response = yield* network
          .handle(toRequestInfo(request.method, url, request.headers))
          .pipe(Effect.mapError((error) => toHttpClientError(request, error)))
        return HttpClientResponse.fromWeb(request, response)
      }),
    )
  }),
)

export const layer = (options?: Options) => {
  const service = serviceLayer(options)
  return Layer.mergeAll(service, httpClientLayer.pipe(Layer.provide(service)))
}

export const denyUnknownLayer = layer({ allowLoopback: true })

export const text = (
  matcher: Matcher,
  body: string | ((request: RequestInfo) => string),
  options?: { status?: number; headers?: Record<string, string> },
) =>
  ({ kind: "text", matcher, body, ...options }) satisfies ResponseEntry

export const json = (
  matcher: Matcher,
  body: unknown | ((request: RequestInfo) => unknown),
  options?: { status?: number; headers?: Record<string, string> },
) =>
  ({ kind: "json", matcher, body, ...options }) satisfies ResponseEntry

export const bytes = (
  matcher: Matcher,
  body: Uint8Array | ((request: RequestInfo) => Uint8Array),
  options?: { status?: number; headers?: Record<string, string> },
) => ({ kind: "bytes", matcher, body, ...options }) satisfies ResponseEntry

export const status = (matcher: Matcher, code: number, options?: { headers?: Record<string, string> }) =>
  ({ kind: "status", matcher, status: code, ...options }) satisfies ResponseEntry

export * as SimulationNetwork from "./network"
