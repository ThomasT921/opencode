import { SimulationActions } from "@/testing/simulation/actions"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { CapturedFrame, CliRenderer } from "@opentui/core"
import { createMockKeys, createMockMouse } from "@opentui/core/testing"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import z from "zod/v4"
import type { SimulationRenderer } from "./simulation"

export type SimulationMcpMode = "stdio" | "remote"

export interface SimulationMcpHarness {
  readonly renderer: CliRenderer
  readonly mockInput: SimulationActions.MockInput
  readonly mockMouse: SimulationActions.MockMouse
  readonly renderOnce: () => Promise<void>
  readonly screen: () => string
}

export interface SimulationMcpOptions {
  readonly mode: SimulationMcpMode
  readonly harness: SimulationMcpHarness
  readonly controlUrl: string
  readonly controlFetch?: typeof fetch
}

export interface SimulationMcpRuntimeState {
  readonly harness: SimulationMcpHarness
  readonly controlUrl: string
  readonly controlFetch?: typeof fetch
}

export interface RestartableSimulationMcpOptions {
  readonly mode: SimulationMcpMode
  readonly runtime: {
    readonly current: () => SimulationMcpRuntimeState | undefined
    readonly restart: () => Promise<unknown>
  }
}

type Options = SimulationMcpOptions | RestartableSimulationMcpOptions

export interface SimulationMcpServer {
  readonly mode: SimulationMcpMode
  readonly url?: string
  readonly stop: () => Promise<void>
}

const DefaultRemotePort = 43110
const MaxPortAttempts = 100
const MasterInstanceID = "master"

interface RemoteInstance {
  readonly id: string
  readonly port: number
  readonly url: string
}

interface JsonRpcResponse {
  readonly result?: unknown
  readonly error?: {
    readonly code?: number
    readonly message?: string
  }
}

type RenderBuffer = {
  readonly width: number
  readonly height: number
  getRealCharBytes(includeAnsi?: boolean): Uint8Array
}

const decoder = new TextDecoder()

const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("typeText"), text: z.string() }),
  z.object({
    type: z.literal("pressKey"),
    key: z.string(),
    modifiers: z
      .object({
        ctrl: z.boolean().optional(),
        shift: z.boolean().optional(),
        meta: z.boolean().optional(),
        super: z.boolean().optional(),
        hyper: z.boolean().optional(),
      })
      .optional(),
  }),
  z.object({ type: z.literal("pressEnter") }),
  z.object({ type: z.literal("pressArrow"), direction: z.enum(["up", "down", "left", "right"]) }),
  z.object({ type: z.literal("focus"), target: z.number() }),
  z.object({ type: z.literal("click"), target: z.number(), x: z.number(), y: z.number() }),
]) satisfies z.ZodType<SimulationActions.Action>

const FileContentSchema = z.union([
  z.string(),
  z.object({ encoding: z.literal("base64"), data: z.string() }),
])

const NetworkRegistrationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("json"),
    url: z.string(),
    method: z.string().optional(),
    status: z.number().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown(),
  }),
  z.object({
    kind: z.literal("text"),
    url: z.string(),
    method: z.string().optional(),
    status: z.number().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string(),
  }),
  z.object({
    kind: z.literal("status"),
    url: z.string(),
    method: z.string().optional(),
    status: z.number(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
])

const LlmScriptActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), content: z.string() }),
  z.object({ type: z.literal("thinking"), content: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.any(),
  }),
])

const LlmScriptSchema = z.object({
  steps: z.array(z.array(LlmScriptActionSchema)),
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      totalTokens: z.number(),
    })
    .optional(),
  finish: z.enum(["stop", "tool-calls", "error", "length", "unknown"]).optional(),
})

const ScriptActionSchema = z.union([
  ActionSchema,
  z.object({ type: z.literal("writeFile"), path: z.string(), content: FileContentSchema }),
  z.object({ type: z.literal("enqueueLLM"), scripts: z.array(LlmScriptSchema) }),
  z.object({ type: z.literal("wait"), ms: z.number().min(0).max(30_000).optional() }),
])

const ScriptSchema = z.union([z.array(ScriptActionSchema), z.object({ actions: z.array(ScriptActionSchema) })])
const TargetSchema = z.union([z.string(), z.array(z.string()).min(1), z.literal("all")])
const BackendFetchSchema = z.object({
  url: z.string(),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
})
const remoteInstances = new Map<string, RemoteInstance>()

function currentBuffer(renderer: CliRenderer): RenderBuffer {
  return Reflect.get(renderer, "currentRenderBuffer") as RenderBuffer
}

function remotePort() {
  const port = Number(process.env.OPENCODE_SIMULATION_MCP_PORT)
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port
  return DefaultRemotePort
}

function masterEnabled() {
  return process.env.OPENCODE_SIMULATION_MCP_MASTER === "1" || process.env.OPENCODE_SIMULATION_MCP_MASTER === "true"
}

function childURL(port: number) {
  return `http://127.0.0.1:${port}/mcp`
}

function jsonRpcError(response: JsonRpcResponse) {
  return response.error?.message ?? `MCP request failed${response.error?.code === undefined ? "" : `: ${response.error.code}`}`
}

function isPortUnavailable(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return message.includes("eaddrinuse") || message.includes("address already in use") || message.includes(" in use")
}

function serveRemote(
  fetch: (request: Request) => Response | Promise<Response>,
  port = remotePort(),
  attempts = MaxPortAttempts,
): ReturnType<typeof Bun.serve> {
  try {
    return Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch })
  } catch (error) {
    if (!isPortUnavailable(error) || attempts <= 1 || port >= 65535) throw error
    return serveRemote(fetch, port + 1, attempts - 1)
  }
}

export function harnessFromSimulationRenderer(renderer: SimulationRenderer): SimulationMcpHarness {
  return renderer
}

export function harnessFromRenderer(renderer: CliRenderer): SimulationMcpHarness {
  return {
    renderer,
    mockInput: createMockKeys(renderer),
    mockMouse: createMockMouse(renderer),
    renderOnce: async () => {
      renderer.requestRender()
      await renderer.idle()
    },
    screen: () => decoder.decode(currentBuffer(renderer).getRealCharBytes(true)),
  }
}

function toolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  }
}

function current(options: Options) {
  if ("runtime" in options) {
    const value = options.runtime.current()
    if (value) return value
    throw new Error("Simulation TUI is not ready")
  }
  return options
}

function state(options: Options) {
  const running = current(options)
  return {
    focused: {
      renderable: running.harness.renderer.currentFocusedRenderable?.num,
      editor: Boolean(running.harness.renderer.currentFocusedEditor),
    },
    elements: SimulationActions.elements(running.harness.renderer),
    actions: SimulationActions.actions(running.harness.renderer),
  }
}

function snapshot(options: Options) {
  const running = current(options)
  return {
    screen: running.harness.screen(),
    ui: state(options),
  }
}

async function control(options: Options, method: string, pathname: string, body?: unknown) {
  const running = current(options)
  const response = await (running.controlFetch ?? fetch)(new URL(pathname, running.controlUrl), {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : undefined
  if (response.ok) return data
  throw new Error(typeof data?.error === "string" ? data.error : `Simulation control request failed: ${response.status}`)
}

async function backendFetch(options: Options, input: z.infer<typeof BackendFetchSchema>) {
  const running = current(options)
  const headers = new Headers(input.headers)
  const body =
    input.body === undefined ? undefined : typeof input.body === "string" ? input.body : JSON.stringify(input.body)
  if (body !== undefined && !headers.has("content-type") && typeof input.body !== "string") headers.set("content-type", "application/json")

  const response = await (running.controlFetch ?? fetch)(new URL(input.url, running.controlUrl), {
    method: input.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
  })
  return {
    url: response.url,
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  }
}

async function mcpRequest(url: string, method: string, params: unknown, timeout = 500) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw new Error(`MCP request failed: HTTP ${response.status}`)
  const data = (await response.json()) as JsonRpcResponse
  if (data.error) throw new Error(jsonRpcError(data))
  return data.result
}

async function initializeChild(url: string, timeout?: number) {
  await mcpRequest(
    url,
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "opencode-simulation-master", version: InstallationVersion },
    },
    timeout,
  )
  await mcpRequest(url, "notifications/initialized", {}, timeout).catch(() => undefined)
}

async function childToolCall(instance: RemoteInstance, name: string, args: unknown) {
  await initializeChild(instance.url, 2_000)
  return mcpRequest(instance.url, "tools/call", { name, arguments: args }, 30_000)
}

function instances() {
  return [{ id: MasterInstanceID, port: remotePort(), url: childURL(remotePort()) }, ...remoteInstances.values()]
}

function selectedTargets(target: z.infer<typeof TargetSchema>) {
  const ids = target === "all" ? instances().map((item) => item.id) : Array.isArray(target) ? target : [target]
  return ids.map((id) => {
    if (id === MasterInstanceID) return { id, local: true as const }
    const remote = remoteInstances.get(id)
    if (!remote) throw new Error(`Unknown simulation instance: ${id}`)
    return { id, local: false as const, remote }
  })
}

async function discoverInstances(input: { startPort?: number; maxPorts?: number; consecutiveFailures?: number } = {}) {
  const startPort = input.startPort ?? remotePort() + 1
  const maxPorts = input.maxPorts ?? 30
  const consecutiveFailures = input.consecutiveFailures ?? 3
  let failures = 0
  const found: RemoteInstance[] = []

  for (let offset = 0; offset < maxPorts && failures < consecutiveFailures; offset++) {
    const port = startPort + offset
    if (port === remotePort()) continue
    const instance = { id: `simulation-${port}`, port, url: childURL(port) }
    try {
      await initializeChild(instance.url)
      await childToolCall(instance, "simulation_control_snapshot", {})
      remoteInstances.set(instance.id, instance)
      found.push(instance)
      failures = 0
    } catch {
      failures++
      remoteInstances.delete(instance.id)
    }
  }

  return { instances: instances(), discovered: found, scanned: { startPort, maxPorts, consecutiveFailures } }
}

async function runScript(options: Options, file: string) {
  const parsed = ScriptSchema.parse(await Bun.file(file).json())
  const actions = Array.isArray(parsed) ? parsed : parsed.actions
  const counts = { uiActions: 0, fileWrites: 0, llmScriptsQueued: 0, waits: 0 }

  for (const action of actions) {
    if (action.type === "writeFile") {
      await control(options, "POST", "/experimental/simulation/filesystem/write", {
        path: action.path,
        content: action.content,
      })
      counts.fileWrites++
      continue
    }
    if (action.type === "enqueueLLM") {
      await control(options, "POST", "/experimental/simulation/llm/enqueue", { scripts: action.scripts })
      counts.llmScriptsQueued += action.scripts.length
      continue
    }
    if (action.type === "wait") {
      await new Promise((resolve) => setTimeout(resolve, action.ms ?? 1_000))
      await current(options).harness.renderOnce()
      counts.waits++
      continue
    }
    await SimulationActions.execute(current(options).harness, action)
    counts.uiActions++
  }

  return { file, actions: actions.length, ...counts, snapshot: snapshot(options) }
}

async function runOnTargets<A>(
  options: Options,
  target: z.infer<typeof TargetSchema>,
  local: () => Promise<A>,
  remote: (instance: RemoteInstance) => Promise<unknown>,
) {
  const output = []
  for (const item of selectedTargets(target)) {
    output.push({ id: item.id, result: item.local ? await local() : await remote(item.remote) })
  }
  return { results: output, snapshot: snapshot(options) }
}

function createServer(options: Options) {
  const server = new McpServer(
    { name: "opencode-simulation", version: InstallationVersion },
    {
      instructions:
        "Use simulation_ui_state_get before acting. Prefer generated actions and execute them with simulation_action_execute. Inspect state after each action. Use control tools to seed filesystem, network, and LLM state.",
    },
  )

  server.registerResource("screen", "simulation://screen", { mimeType: "text/plain" }, () => ({
    contents: [{ uri: "simulation://screen", mimeType: "text/plain", text: current(options).harness.screen() }],
  }))
  server.registerResource("ui-state", "simulation://ui-state", { mimeType: "application/json" }, () => ({
    contents: [{ uri: "simulation://ui-state", mimeType: "application/json", text: JSON.stringify(state(options)) }],
  }))
  server.registerResource("backend-snapshot", "simulation://backend-snapshot", { mimeType: "application/json" }, async () => ({
    contents: [
      {
        uri: "simulation://backend-snapshot",
        mimeType: "application/json",
        text: JSON.stringify(await control(options, "GET", "/experimental/simulation/snapshot")),
      },
    ],
  }))

  server.registerPrompt("simulation-driver", { description: "Instructions for driving the simulated TUI." }, () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Inspect simulation_ui_state_get, choose one generated action, call simulation_action_execute, then inspect again. Use control tools to seed deterministic backend state.",
        },
      },
    ],
  }))

  server.registerTool("simulation_screen_get", { description: "Get the current TUI screen buffer." }, () =>
    toolResult({ screen: current(options).harness.screen() }),
  )
  server.registerTool("simulation_ui_state_get", { description: "Get elements, focus state, and generated actions." }, () =>
    toolResult(state(options)),
  )
  server.registerTool("simulation_render_once", { description: "Force one render and return current state." }, async () => {
    await current(options).harness.renderOnce()
    return toolResult(snapshot(options))
  })
  server.registerTool(
    "simulation_backend_fetch",
    {
      description: "Proxy one fetch request through the simulated backend and return the raw response.",
      inputSchema: BackendFetchSchema,
    },
    async (input) => toolResult(await backendFetch(options, input)),
  )
  server.registerTool(
    "simulation_action_execute",
    {
      description: "Execute one generated simulation action and render once.",
      inputSchema: z.object({ action: ActionSchema }),
    },
    async (input) => {
      await SimulationActions.execute(current(options).harness, input.action)
      return toolResult(snapshot(options))
    },
  )
  server.registerTool(
    "simulation_action_sequence_execute",
    {
      description: "Execute a bounded sequence of simulation actions and return final state.",
      inputSchema: z.object({ actions: z.array(ActionSchema).max(50) }),
    },
    async (input) => {
      for (const action of input.actions) await SimulationActions.execute(current(options).harness, action)
      return toolResult(snapshot(options))
    },
  )
  server.registerTool(
    "simulation_script_run",
    {
      description: "Run a JSON simulation script from a host filesystem path.",
      inputSchema: z.object({ path: z.string() }),
    },
    async (input) => toolResult(await runScript(options, input.path)),
  )

  if ("runtime" in options) {
    server.registerTool("simulation_restart", { description: "Restart the simulated TUI and backend while keeping MCP alive." }, async () =>
      toolResult(await options.runtime.restart()),
    )
  }

  server.registerTool("simulation_control_reset", { description: "Reset backend simulation state." }, async () =>
    toolResult(await control(options, "POST", "/experimental/simulation/reset")),
  )
  server.registerTool(
    "simulation_control_filesystem_seed",
    {
      description: "Seed backend simulated filesystem files.",
      inputSchema: z.object({ files: z.record(z.string(), FileContentSchema) }),
    },
    async (input) => toolResult(await control(options, "POST", "/experimental/simulation/filesystem/seed", input)),
  )
  server.registerTool(
    "simulation_control_filesystem_write",
    {
      description: "Write one file into the backend simulated filesystem.",
      inputSchema: z.object({ path: z.string(), content: FileContentSchema }),
    },
    async (input) => toolResult(await control(options, "POST", "/experimental/simulation/filesystem/write", input)),
  )
  server.registerTool(
    "simulation_control_network_register",
    {
      description: "Register one backend simulated network response.",
      inputSchema: NetworkRegistrationSchema,
    },
    async (input) => toolResult(await control(options, "POST", "/experimental/simulation/network/register", input)),
  )
  server.registerTool(
    "simulation_control_llm_enqueue",
    {
      description: "Queue backend mock LLM scripts.",
      inputSchema: z.object({ scripts: z.array(LlmScriptSchema) }),
    },
    async (input) => toolResult(await control(options, "POST", "/experimental/simulation/llm/enqueue", input)),
  )
  server.registerTool("simulation_control_snapshot", { description: "Get backend simulation state snapshot." }, async () =>
    toolResult(await control(options, "GET", "/experimental/simulation/snapshot")),
  )

  if (masterEnabled()) {
    server.registerTool(
      "simulation_instances_discover",
      {
        description: "Discover child simulation MCP servers on sequential localhost ports.",
        inputSchema: z.object({
          startPort: z.number().optional(),
          maxPorts: z.number().optional(),
          consecutiveFailures: z.number().optional(),
        }),
      },
      async (input) => toolResult(await discoverInstances(input)),
    )
    server.registerTool("simulation_instances_list", { description: "List known simulation instances." }, () =>
      toolResult({ instances: instances() }),
    )
    server.registerTool(
      "simulation_instances_action_execute",
      {
        description: "Execute one UI action on one or more simulation instances.",
        inputSchema: z.object({ target: TargetSchema, action: ActionSchema }),
      },
      async (input) =>
        toolResult(
          await runOnTargets(
            options,
            input.target,
            async () => {
              await SimulationActions.execute(current(options).harness, input.action)
              return snapshot(options)
            },
            (instance) => childToolCall(instance, "simulation_action_execute", { action: input.action }),
          ),
        ),
    )
    server.registerTool(
      "simulation_instances_filesystem_write",
      {
        description: "Write one file on one or more simulation instances.",
        inputSchema: z.object({ target: TargetSchema, path: z.string(), content: FileContentSchema }),
      },
      async (input) =>
        toolResult(
          await runOnTargets(
            options,
            input.target,
            () => control(options, "POST", "/experimental/simulation/filesystem/write", { path: input.path, content: input.content }),
            (instance) => childToolCall(instance, "simulation_control_filesystem_write", { path: input.path, content: input.content }),
          ),
        ),
    )
    server.registerTool(
      "simulation_instances_llm_enqueue",
      {
        description: "Queue LLM scripts on one or more simulation instances.",
        inputSchema: z.object({ target: TargetSchema, scripts: z.array(LlmScriptSchema) }),
      },
      async (input) =>
        toolResult(
          await runOnTargets(
            options,
            input.target,
            () => control(options, "POST", "/experimental/simulation/llm/enqueue", { scripts: input.scripts }),
            (instance) => childToolCall(instance, "simulation_control_llm_enqueue", { scripts: input.scripts }),
          ),
        ),
    )
    server.registerTool(
      "simulation_instances_script_run",
      {
        description: "Run a JSON simulation script on one or more simulation instances.",
        inputSchema: z.object({ target: TargetSchema, path: z.string() }),
      },
      async (input) =>
        toolResult(
          await runOnTargets(
            options,
            input.target,
            () => runScript(options, input.path),
            (instance) => childToolCall(instance, "simulation_script_run", { path: input.path }),
          ),
        ),
    )
  }

  return server
}

export async function createSimulationMcpServer(options: Options): Promise<SimulationMcpServer> {
  if (options.mode === "stdio") {
    const server = createServer(options)
    const transport = new StdioServerTransport()
    await server.connect(transport)
    return {
      mode: options.mode,
      stop: () => server.close(),
    }
  }

  const servers = new Set<McpServer>()

  const http = serveRemote(
    async (request) => {
      if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 })
      const server = createServer(options)
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      servers.add(server)
      request.signal.addEventListener("abort", () => {
        servers.delete(server)
        void server.close()
      })
      await server.connect(transport)
      return transport.handleRequest(request)
    },
  )

  return {
    mode: options.mode,
    url: `http://${http.hostname}:${http.port}/mcp`,
    stop: async () => {
      http.stop(true)
      await Promise.all([...servers].map((server) => server.close()))
      servers.clear()
    },
  }
}

export * as TuiSimulationMcp from "./simulation-mcp"
