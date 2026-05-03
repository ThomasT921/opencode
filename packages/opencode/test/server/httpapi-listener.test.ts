import { afterEach, describe, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Project } from "../../src/project/project"
import { HttpApiListener } from "../../src/server/httpapi-listener"
import { PtyPaths } from "../../src/server/routes/instance/httpapi/groups/pty"
import { Effect } from "effect"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI
const testPty = process.platform === "win32" ? test.skip : test

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

async function startListener() {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
  return HttpApiListener.listen({ hostname: "127.0.0.1", port: 0 })
}

describe("native HttpApi listener", () => {
  test("serves HTTP routes via the HttpApi web handler", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const listener = await startListener()
    try {
      const response = await fetch(`${listener.url.origin}${PtyPaths.shells}`, {
        headers: { "x-opencode-directory": tmp.path },
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(Array.isArray(body)).toBe(true)
      expect(body[0]).toMatchObject({
        path: expect.any(String),
        name: expect.any(String),
        acceptable: expect.any(Boolean),
      })
    } finally {
      await listener.stop(true)
    }
  })

  test("workspace-proxy WS forwarding round-trips through a fake remote", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    // Tiny Bun.serve fake remote that echoes every WS frame it receives.
    type EchoState = { closed: boolean }
    const remote = Bun.serve<EchoState>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (server.upgrade(request, { data: { closed: false } })) return undefined
          return new Response("upgrade failed", { status: 400 })
        }
        return new Response("ok")
      },
      websocket: {
        open(_ws: ServerWebSocket<EchoState>) {},
        message(ws: ServerWebSocket<EchoState>, msg: string | Buffer) {
          ws.send(typeof msg === "string" ? `echo:${msg}` : msg)
        },
        close(_ws: ServerWebSocket<EchoState>) {},
      },
    })

    // The path "/probe" is not a known local-only or PTY route, so the listener
    // should treat it as a candidate for workspace-proxy WS forwarding.
    const remoteBase = `http://${remote.hostname}:${remote.port}`

    // Register a remote workspace whose target points at the echo server.
    const adapter: WorkspaceAdapter = {
      name: "Remote Listener Test",
      description: "Remote workspace target for HttpApiListener proxy WS test",
      configure: (info) => ({ ...info, name: "remote-listener-test", directory: path.join(tmp.path, ".remote") }),
      create: async () => {
        await mkdir(path.join(tmp.path, ".remote"), { recursive: true })
      },
      async remove() {},
      target: () => ({ type: "remote" as const, url: remoteBase }),
    }

    const workspaceID = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const project = yield* Project.Service.use((svc) => svc.fromDirectory(tmp.path))
        registerAdapter(project.project.id, "httpapi-listener-proxy-ws", adapter)
        const created = yield* Workspace.Service.use((svc) =>
          svc.create({
            type: "httpapi-listener-proxy-ws",
            branch: null,
            extra: null,
            projectID: project.project.id,
          }),
        )
        return created.id
      }),
    )

    const listener = await startListener()
    try {
      const wsURL = new URL("/probe", listener.url)
      wsURL.protocol = "ws:"
      wsURL.searchParams.set("workspace", workspaceID)

      const messages: string[] = []
      const ws = new WebSocket(wsURL)
      ws.binaryType = "arraybuffer"

      const opened = new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true })
        ws.addEventListener("error", () => reject(new Error("ws error before open")), { once: true })
      })

      ws.addEventListener("message", (event) => {
        const data = event.data
        messages.push(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer))
      })

      await opened
      ws.send("hello-proxy")

      const start = Date.now()
      while (!messages.some((m) => m === "echo:hello-proxy") && Date.now() - start < 5_000) {
        await new Promise((r) => setTimeout(r, 25))
      }

      expect(messages).toContain("echo:hello-proxy")

      ws.close(1000, "done")
    } finally {
      await listener.stop(true)
      remote.stop(true)
    }
  })

  testPty("PTY websocket connect echoes input back to the client", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const listener = await startListener()
    try {
      const created = await fetch(`${listener.url.origin}${PtyPaths.create}`, {
        method: "POST",
        headers: {
          "x-opencode-directory": tmp.path,
          "content-type": "application/json",
        },
        body: JSON.stringify({ command: "/bin/cat", title: "listener-smoke" }),
      })
      expect(created.status).toBe(200)
      const info = (await created.json()) as { id: string }

      try {
        const wsURL = new URL(PtyPaths.connect.replace(":ptyID", info.id), listener.url)
        wsURL.protocol = "ws:"
        wsURL.searchParams.set("directory", tmp.path)
        wsURL.searchParams.set("cursor", "-1")

        const messages: string[] = []
        const ws = new WebSocket(wsURL)
        ws.binaryType = "arraybuffer"

        const opened = new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => resolve(), { once: true })
          ws.addEventListener("error", () => reject(new Error("ws error before open")), { once: true })
        })

        const closed = new Promise<void>((resolve) => {
          ws.addEventListener("close", () => resolve(), { once: true })
        })

        ws.addEventListener("message", (event) => {
          const data = event.data
          messages.push(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer))
        })

        await opened
        ws.send("ping-listener\n")

        const start = Date.now()
        while (!messages.some((m) => m.includes("ping-listener")) && Date.now() - start < 5_000) {
          await new Promise((r) => setTimeout(r, 50))
        }
        ws.close(1000, "done")

        expect(messages.some((m) => m.includes("ping-listener"))).toBe(true)
        // Verify close event fires (handler.onClose path runs and the
        // Bun.serve websocket lifecycle reaches close).
        await closed
        expect(ws.readyState).toBe(WebSocket.CLOSED)
      } finally {
        await fetch(`${listener.url.origin}${PtyPaths.remove.replace(":ptyID", info.id)}`, {
          method: "DELETE",
          headers: { "x-opencode-directory": tmp.path },
        }).catch(() => undefined)
      }
    } finally {
      await listener.stop(true)
    }
  })
})
