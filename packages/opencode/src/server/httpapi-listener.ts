// TODO: Node adapter forthcoming — same pattern but using `node:http` + `ws` library,
// and `node:http`'s `upgrade` event.
//
// This module is a Bun-only proof-of-concept for a native `Bun.serve` listener that
// drives the experimental HttpApi handler directly (no Hono in the middle) and handles
// WebSocket upgrades inline based on path-matching. It exists to validate the pattern
// before deleting the Hono backend; `Server.listen()` is intentionally NOT wired to it.

import type { ServerWebSocket } from "bun"
import { Effect, Schema } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { AppRuntime } from "@/effect/app-runtime"
import { WithInstance } from "@/project/with-instance"
import { Pty } from "@/pty"
import { handlePtyInput } from "@/pty/input"
import { PtyID } from "@/pty/schema"
import { PtyPaths } from "@/server/routes/instance/httpapi/groups/pty"
import { ExperimentalHttpApiServer } from "@/server/routes/instance/httpapi/server"
import { getAdapter } from "@/control-plane/adapters"
import { WorkspaceID } from "@/control-plane/schema"
import { Workspace } from "@/control-plane/workspace"
import { Session } from "@/session/session"
import * as Log from "@opencode-ai/core/util/log"
import type { CorsOptions } from "./cors"
import { ProxyUtil } from "./proxy-util"
import { getWorkspaceRouteSessionID, isLocalWorkspaceRoute, workspaceProxyURL } from "./shared/workspace-routing"

const log = Log.create({ service: "httpapi-listener" })
const decodePtyID = Schema.decodeUnknownSync(PtyID)

export type Listener = {
  hostname: string
  port: number
  url: URL
  stop: (close?: boolean) => Promise<void>
}

export type ListenOptions = CorsOptions & {
  port: number
  hostname: string
}

type WsKind =
  | { kind: "pty"; ptyID: string; cursor: number | undefined; directory: string }
  | { kind: "proxy"; remoteURL: string; subprotocols: string[] }

type PtyHandler = {
  onMessage: (message: string | ArrayBuffer) => void
  onClose: () => void
}

type WsState = WsKind & {
  // pty fields
  handler?: PtyHandler
  pending: Array<string | Uint8Array>
  ready: boolean
  closed: boolean
  // proxy fields
  remote?: WebSocket
  proxyQueue?: Array<string | Uint8Array | ArrayBuffer>
}

// Derive from the OpenAPI path so this stays in sync if the route literal moves.
const ptyConnectPattern = new RegExp(`^${PtyPaths.connect.replace(/:[^/]+/g, "([^/]+)")}$`)

function parseCursor(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < -1) return undefined
  return parsed
}

function openProxy(ws: ServerWebSocket<WsState>) {
  const data = ws.data
  if (data.kind !== "proxy") return
  let remote: WebSocket
  try {
    remote = new WebSocket(data.remoteURL, data.subprotocols.length ? data.subprotocols : undefined)
  } catch (err) {
    log.error("proxy remote WebSocket construct failed", { error: err })
    ws.close(1011, "proxy connect failed")
    return
  }
  remote.binaryType = "arraybuffer"
  data.remote = remote

  remote.onopen = () => {
    const queue = data.proxyQueue
    if (queue) {
      for (const item of queue) {
        try {
          remote.send(item as never)
        } catch {
          // ignore — close handlers will clean up
        }
      }
      queue.length = 0
    }
  }
  remote.onmessage = (event: MessageEvent) => {
    try {
      const payload = event.data
      if (typeof payload === "string") {
        ws.send(payload)
      } else if (payload instanceof ArrayBuffer) {
        ws.send(new Uint8Array(payload))
      } else if (payload instanceof Uint8Array) {
        ws.send(payload)
      } else if (payload instanceof Blob) {
        void payload.arrayBuffer().then((buf) => {
          try {
            ws.send(new Uint8Array(buf))
          } catch {
            // ignore
          }
        })
      }
    } catch {
      // ignore — socket likely closed
    }
  }
  remote.onerror = () => {
    try {
      ws.close(1011, "proxy error")
    } catch {
      // ignore
    }
  }
  remote.onclose = (event: CloseEvent) => {
    try {
      ws.close(event.code, event.reason)
    } catch {
      // ignore
    }
  }
}

function asAdapter(ws: ServerWebSocket<WsState>) {
  return {
    get readyState() {
      return ws.readyState
    },
    send: (data: string | Uint8Array | ArrayBuffer) => {
      try {
        if (data instanceof ArrayBuffer) ws.send(new Uint8Array(data))
        else ws.send(data)
      } catch {
        // socket likely already closed; ignore
      }
    },
    close: (code?: number, reason?: string) => {
      try {
        ws.close(code, reason)
      } catch {
        // ignore
      }
    },
  }
}

async function resolveWorkspaceProxy(
  request: Request,
  url: URL,
): Promise<{ remoteURL: URL; subprotocols: string[] } | undefined> {
  // Skip proxy resolution entirely when this process is pinned to a single
  // workspace (the Hono path's WorkspaceRouterMiddleware uses the same guard).
  if (Flag.OPENCODE_WORKSPACE_ID) return undefined

  // Local-only routes (e.g. /experimental/workspace, GET /session) never
  // forward — match the Hono behavior even though those routes don't currently
  // upgrade to WS.
  if (isLocalWorkspaceRoute(request.method, url.pathname)) return undefined

  // /console paths are served locally and never proxied.
  if (url.pathname.startsWith("/console")) return undefined

  let workspaceID: string | null = null

  // Prefer session-derived workspace lookup when a session ID is present in
  // the path; fall back to the explicit ?workspace=... query parameter.
  const sessionID = getWorkspaceRouteSessionID(url)
  if (sessionID) {
    const session = await AppRuntime.runPromise(
      Session.Service.use((svc) => svc.get(sessionID)).pipe(Effect.withSpan("HttpApiListener.proxy.session")),
    ).catch(() => undefined)
    if (session?.workspaceID) workspaceID = session.workspaceID
  }
  if (!workspaceID) workspaceID = url.searchParams.get("workspace")
  if (!workspaceID) return undefined

  const workspace = await AppRuntime.runPromise(
    Workspace.Service.use((svc) => svc.get(WorkspaceID.make(workspaceID))).pipe(
      Effect.withSpan("HttpApiListener.proxy.workspace"),
    ),
  ).catch(() => undefined)
  if (!workspace) return undefined

  const adapter = getAdapter(workspace.projectID, workspace.type)
  const target = await adapter.target(workspace)
  if (target.type !== "remote") return undefined

  const proxyURL = workspaceProxyURL(target.url, url)
  const remoteURL = new URL(ProxyUtil.websocketTargetURL(proxyURL))
  return {
    remoteURL,
    subprotocols: ProxyUtil.websocketProtocols(request),
  }
}

/**
 * Spin up a native Bun.serve that:
 *   1. Routes all HTTP traffic through the HttpApi web handler.
 *   2. Intercepts known WebSocket upgrade paths and handles them inline.
 *
 * This bypasses Hono entirely. The Hono code path remains untouched.
 */
export async function listen(opts: ListenOptions): Promise<Listener> {
  const built = ExperimentalHttpApiServer.webHandler(opts)
  const handler = built.handler
  const context = ExperimentalHttpApiServer.context

  const start = (port: number) => {
    try {
      return Bun.serve<WsState>({
        hostname: opts.hostname,
        port,
        idleTimeout: 0,
        async fetch(request, server) {
          const url = new URL(request.url)
          const isUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket"
          const ptyMatch = url.pathname.match(ptyConnectPattern)
          if (ptyMatch && isUpgrade) {
            const ptyID = ptyMatch[1]!
            const cursor = parseCursor(url.searchParams.get("cursor"))
            // Resolve the instance directory the same way the HttpApi
            // `instance-context` middleware does (search params, then header,
            // then process.cwd()).
            const directory =
              url.searchParams.get("directory") ?? request.headers.get("x-opencode-directory") ?? process.cwd()
            const upgraded = server.upgrade(request, {
              data: {
                kind: "pty",
                ptyID,
                cursor,
                directory,
                pending: [],
                ready: false,
                closed: false,
              } satisfies WsState,
            })
            if (upgraded) return undefined
            return new Response("upgrade failed", { status: 400 })
          }

          // Workspace-proxy WS forwarding. Mirrors the Hono path's
          // `WorkspaceRouterMiddleware` → `ServerProxy.websocket` flow but inline.
          // Bridging to the remote `new WebSocket(...)` happens inside the
          // `websocket.open` handler below.
          //
          // TODO: Node adapter (no Bun.serve) needs an equivalent path using
          // `node:http` + `ws`.
          if (isUpgrade) {
            try {
              const proxy = await resolveWorkspaceProxy(request, url)
              if (proxy) {
                log.info("workspace-proxy websocket", {
                  request: url.toString(),
                  remote: proxy.remoteURL.toString(),
                })
                const upgraded = server.upgrade(request, {
                  data: {
                    kind: "proxy",
                    remoteURL: proxy.remoteURL.toString(),
                    subprotocols: proxy.subprotocols,
                    pending: [],
                    ready: false,
                    closed: false,
                    proxyQueue: [],
                  } satisfies WsState,
                })
                if (upgraded) return undefined
                return new Response("upgrade failed", { status: 400 })
              }
            } catch (err) {
              log.error("workspace-proxy ws resolve failed", { error: err })
              return new Response("workspace lookup failed", { status: 500 })
            }
          }

          return handler(request as Request, context as never)
        },
        websocket: {
          open(ws) {
            const data = ws.data
            if (data.kind === "proxy") {
              openProxy(ws)
              return
            }
            if (data.kind !== "pty") {
              ws.close(1011, "unknown ws kind")
              return
            }
            const id = (() => {
              try {
                return decodePtyID(data.ptyID)
              } catch {
                ws.close(1008, "invalid pty id")
                return undefined
              }
            })()
            if (!id) return
            ;(async () => {
              const result = await WithInstance.provide({
                directory: data.directory,
                fn: () =>
                  AppRuntime.runPromise(
                    Effect.gen(function* () {
                      const pty = yield* Pty.Service
                      return yield* pty.connect(id, asAdapter(ws), data.cursor)
                    }).pipe(Effect.withSpan("HttpApiListener.pty.connect.open")),
                  ),
              })
              return await result
            })()
              .then((handler) => {
                if (data.closed) {
                  handler?.onClose()
                  return
                }
                if (!handler) {
                  ws.close(4404, "session not found")
                  return
                }
                data.handler = handler
                data.ready = true
                for (const msg of data.pending) {
                  AppRuntime.runPromise(handlePtyInput(handler, msg)).catch(() => undefined)
                }
                data.pending.length = 0
              })
              .catch((err) => {
                log.error("pty connect failed", { error: err })
                ws.close(1011, "pty connect failed")
              })
          },
          message(ws, message) {
            const data = ws.data
            if (data.kind === "proxy") {
              const payload =
                typeof message === "string"
                  ? message
                  : message instanceof Buffer
                    ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
                    : (message as Uint8Array)
              const remote = data.remote
              if (remote && remote.readyState === WebSocket.OPEN) {
                try {
                  remote.send(payload)
                } catch {
                  // ignore send errors; lifecycle handlers will tear things down
                }
                return
              }
              data.proxyQueue?.push(payload)
              return
            }
            if (data.kind !== "pty") return
            const payload =
              typeof message === "string"
                ? message
                : message instanceof Buffer
                  ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
                  : (message as Uint8Array)
            if (!data.ready || !data.handler) {
              data.pending.push(payload)
              return
            }
            AppRuntime.runPromise(handlePtyInput(data.handler, payload)).catch(() => undefined)
          },
          close(ws, code, reason) {
            const data = ws.data
            data.closed = true
            if (data.kind === "proxy") {
              try {
                data.remote?.close(code, reason)
              } catch {
                // ignore
              }
              return
            }
            data.handler?.onClose()
          },
        },
      })
    } catch (err) {
      log.error("Bun.serve failed", { error: err })
      return undefined
    }
  }

  const server = opts.port === 0 ? (start(4096) ?? start(0)) : start(opts.port)
  if (!server) throw new Error(`Failed to start server on port ${opts.port}`)
  const port = server.port
  if (port === undefined) throw new Error("Bun.serve started without a numeric port")

  const url = new URL("http://localhost")
  url.hostname = opts.hostname
  url.port = String(port)

  let closing: Promise<void> | undefined
  return {
    hostname: opts.hostname,
    port,
    url,
    stop(close?: boolean) {
      closing ??= (async () => {
        await server.stop(close)
        // NOTE: we deliberately do NOT call `built.dispose()` here. The
        // underlying `webHandler` is memoized at module level (same as the
        // Hono path), so disposing it would tear down shared services for
        // every other consumer in the process. Lifecycle teardown is owned
        // by the AppRuntime itself.
      })()
      return closing
    },
  }
}

export * as HttpApiListener from "./httpapi-listener"
