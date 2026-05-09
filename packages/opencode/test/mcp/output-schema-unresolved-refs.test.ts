// Reproducer for opencode issue #26529
//
// When an MCP server's `tools/list` response contains a tool whose
// `outputSchema` has an unresolved `$ref` (e.g. `#/$defs/ScreenInstance`),
// the MCP SDK's response validation throws on the entire `listTools()`
// call. opencode currently treats this as a fatal error and marks the
// whole server as `failed`, even though the server has other valid tools
// that should still be usable.
//
// Expected behavior: opencode should skip tools with malformed schemas
// and keep the server connected with its remaining valid tools.

import { test, expect, mock, beforeEach } from "bun:test"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { Effect } from "effect"
import type { MCP as MCPNS } from "../../src/mcp/index"

// --- Mock infrastructure (mirrors lifecycle.test.ts patterns) ---

interface MockClientState {
  tools: Array<{ name: string; description?: string; inputSchema: object; outputSchema?: object }>
  listToolsShouldFail: boolean
  listToolsError: string
  notificationHandlers: Map<unknown, (...args: any[]) => any>
  closed: boolean
}

const clientStates = new Map<string, MockClientState>()
let lastCreatedClientName: string | undefined

function getOrCreateClientState(name?: string): MockClientState {
  const key = name ?? "default"
  let state = clientStates.get(key)
  if (!state) {
    state = {
      tools: [],
      listToolsShouldFail: false,
      listToolsError: "listTools failed",
      notificationHandlers: new Map(),
      closed: false,
    }
    clientStates.set(key, state)
  }
  return state
}

class MockStdioTransport {
  stderr: null = null
  pid = 12345
  // oxlint-disable-next-line no-useless-constructor
  constructor(_opts: any) {}
  async start() {}
  async close() {}
}

class MockStreamableHTTP {
  // oxlint-disable-next-line no-useless-constructor
  constructor(_url: URL, _opts?: any) {}
  async start() {}
  async close() {}
  async finishAuth() {}
}

class MockSSE {
  // oxlint-disable-next-line no-useless-constructor
  constructor(_url: URL, _opts?: any) {}
  async start() {}
  async close() {}
}

void mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockStdioTransport,
}))

void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTP,
}))

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: MockSSE,
}))

void mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {
    constructor() {
      super("Unauthorized")
    }
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    _state!: MockClientState
    transport: any
    // oxlint-disable-next-line no-useless-constructor
    constructor(_opts: any) {}
    async connect(transport: { start: () => Promise<void> }) {
      this.transport = transport
      await transport.start()
      this._state = getOrCreateClientState(lastCreatedClientName)
    }
    setNotificationHandler(schema: unknown, handler: (...args: any[]) => any) {
      this._state?.notificationHandlers.set(schema, handler)
    }
    async listTools() {
      if (this._state?.listToolsShouldFail) {
        throw new Error(this._state.listToolsError)
      }
      return { tools: this._state?.tools ?? [] }
    }
    async request(req: { method: string }) {
      // The fix retries via raw `request("tools/list", ...)` with a
      // tolerant schema after the typed listTools() rejects on a bad
      // outputSchema reference. The retry path bypasses the SDK's
      // strict validator, so the mock returns the same tools list
      // without the validation that originally threw.
      if (req.method === "tools/list") return { tools: this._state?.tools ?? [] }
      throw new Error(`unsupported request: ${req.method}`)
    }
    async listPrompts() {
      return { prompts: [] }
    }
    async listResources() {
      return { resources: [] }
    }
    async close() {
      if (this._state) this._state.closed = true
    }
  },
}))

beforeEach(() => {
  clientStates.clear()
  lastCreatedClientName = undefined
})

const { MCP } = await import("../../src/mcp/index")
const { Instance } = await import("../../src/project/instance")
const { WithInstance } = await import("../../src/project/with-instance")
const { tmpdir } = await import("../fixture/fixture")

function withInstance(
  config: Record<string, unknown>,
  fn: (mcp: MCPNS.Interface) => Effect.Effect<void, unknown, never>,
) {
  return async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/opencode.json`,
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            mcp: config,
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.runPromise(MCP.Service.use(fn).pipe(Effect.provide(MCP.defaultLayer)))
        await InstanceRuntime.disposeInstance(Instance.current)
      },
    })
  }
}

// ========================================================================
// Reproducer: outputSchema with unresolved $ref fails the whole server
// ========================================================================
//
// In the real bug, the MCP SDK's response-validation layer attempts to
// resolve `$ref`s inside a tool's `outputSchema`. When a referenced
// definition is missing (e.g. `#/$defs/ScreenInstance`), validation
// throws something like:
//
//   can't resolve reference #/$defs/ScreenInstance from id #
//
// `client.listTools()` therefore rejects, opencode's `defs()` catches
// the error and returns `undefined`, and `create()` then marks the whole
// MCP server as `failed` -- losing access to all other valid tools the
// server exposes.
//
// This test simulates the same failure path by making `listTools()`
// throw the same error, and asserts the server stays connected with its
// valid tool exposed.

test(
  "tool with unresolved $ref in outputSchema does not fail the whole server",
  withInstance(
    {
      "screen-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "screen-server"
        const serverState = getOrCreateClientState("screen-server")

        // Simulate the SDK's validation throwing on the bad outputSchema.
        // This is exactly what happens in the wild when one tool in
        // tools/list has an `outputSchema` like:
        //   { $ref: "#/$defs/ScreenInstance" }
        // with no `$defs` block to resolve against.
        serverState.tools = [
          {
            name: "good_tool",
            description: "valid tool that should still load",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "bad_tool",
            description: "tool with unresolved outputSchema $ref",
            inputSchema: { type: "object", properties: {} },
            outputSchema: { $ref: "#/$defs/ScreenInstance" },
          },
        ]
        serverState.listToolsShouldFail = true
        serverState.listToolsError = "can't resolve reference #/$defs/ScreenInstance from id #"

        yield* mcp.add("screen-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const status = yield* mcp.status()

        // Expected: the server should remain connected because at least
        // one tool (`good_tool`) has a valid schema.
        expect(status["screen-server"]?.status).toBe("connected")

        // Expected: the valid tool should be available even though one
        // of the server's tools had a bad outputSchema.
        const tools = yield* mcp.tools()
        expect(Object.keys(tools).some((k) => k.includes("good_tool"))).toBe(true)
      }),
  ),
)
