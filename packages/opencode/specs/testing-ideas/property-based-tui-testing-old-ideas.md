# Property-Based TUI And Backend Testing Plan

Status: rough architectural draft.

This document sketches an incremental path for property-based, deterministic-simulation-style testing of the opencode TUI against a real opencode backend, without hitting external network services.

## Goals

- Drive the TUI as the primary user surface.
- Exercise the real backend request, session, message, tool, permission, and event pipelines.
- Replace external effects with deterministic local services.
- Record enough information to replay failures.
- Build a semantic model of UI actions, backend requests, and state transitions over time.
- Start with a small useful runner, then grow toward deterministic simulation testing.

## Non-Goals For The First Pass

- Full fake-clock replacement for every `setTimeout`, `Date.now`, and animation path.
- Exhaustive exploration of every visual TUI state.
- Web app testing.
- Real external LLM/provider, MCP, webfetch, websearch, update, or share network calls.

## Current Code Map

### TUI

- TUI startup is centered in `packages/opencode/src/cli/cmd/tui/thread.ts` and `packages/opencode/src/cli/cmd/tui/app.tsx`.
- `TuiThreadCommand` starts a worker, builds an in-process fetch/event transport when possible, and calls `tui(...)`.
- `tui(...)` creates the OpenTUI `CliRenderer`, creates the keymap, and renders the Solid app.
- `SDKProvider` in `context/sdk.tsx` owns SDK creation, custom fetch injection, event subscription, event batching, retry, and timers.
- `SyncProvider` in `context/sync.tsx` projects backend events into TUI state: sessions, messages, parts, permissions, questions, todos, diffs, MCP, formatter, LSP, and VCS.
- `RouteProvider` in `context/route.tsx` owns route state.
- `PromptRefProvider` in `context/prompt.tsx` exposes the current prompt ref.
- The main prompt is `component/prompt/index.tsx`. It exposes `set`, `reset`, and `submit` through `PromptRef`, and its submit path eventually calls SDK session APIs.
- `keymap.tsx` centralizes base keymap registration and re-exports `useBindings`; app and prompt commands are registered through this layer.
- `plugin/api.tsx` already centralizes access to renderer, route, keymap, state, SDK client, dialog, KV, and event APIs. This is a useful model for a test harness API.

### Backend

- `packages/opencode/src/server/server.ts` exposes `Server.Default().app.request(...)`, which is useful for in-process HTTP tests.
- `packages/opencode/src/server/routes/instance/httpapi/server.ts` assembles all routes and provides production service layers.
- `createRoutes(...)` currently provides concrete production layers inside the route builder, including `Provider.defaultLayer`, `MCP.defaultLayer`, `ToolRegistry.defaultLayer`, `AppFileSystem.defaultLayer`, and `FetchHttpClient.layer`.
- `groups/session.ts` and `handlers/session.ts` define the important session HTTP surface: create, prompt, prompt_async, command, shell, abort, permission response, message reads, revert, and update paths.
- `SessionPrompt.Service` in `session/prompt.ts` creates user messages, resolves prompt parts, resolves tools, loops over LLM/tool calls, and writes messages/parts.
- `LLM.Service` in `session/llm.ts` is the main provider seam. It calls `Provider.Service.getLanguage(...)` and then `streamText(...)`.
- `Provider.Service` in `provider/provider.ts` can dynamically load provider SDKs and may install packages or use network. Simulation should use the normal provider path with a local mock provider/model and sandbox/network guards, not wholesale service replacement.
- `MCP.Service` in `mcp/index.ts` can open remote HTTP/SSE connections or local child processes. Simulation should keep normal app startup and disable/configure MCP by default; only add a narrow MCP control seam when a test needs MCP states.
- `ToolRegistry.Service` in `tool/registry.ts` exposes built-in and plugin tools. Filesystem tools should run against the mock filesystem in simulation mode; process/network tools must be disabled or replaced.
- `Database.Path` in `storage/db.ts` is controlled by `OPENCODE_DB` and supports `:memory:`. Tests already reset/close DB state.
- `Identifier` in `id/id.ts`, many `Date.now()` calls, and some `Math.random()` use are determinism hazards.

### Previous `jlongster/fuzz-backend` Branch

Useful ideas:

- A mock AI SDK provider emitted real language-model stream chunks.
- The old branch showed that a compact scripted action format works, but scripts must be supplied through simulation control APIs instead of user prompt text.
- Actions included `text`, `thinking`, `tool_call`, `list_tools`, and `error`.
- Step selection by counting tool-result rounds after the last user message was a good fit for model/tool loops.
- The runner drove the backend through HTTP plus SSE, waited for `session.status` to become idle, and then inspected messages.
- `/experimental/tool` discovery plus schema-based fake input generation was a useful generation seed.
- The TUI runner used an internal component to select the mock model, set prompt text through `PromptRef`, submit, and wait for idle.
- The differential runner normalized volatile fields and compared runs.
- The runner forced SQLite to `:memory:` so each run started with a clean in-process database.
- The runner used macOS `sandbox-exec` to deny external network and host filesystem access around the whole app process.
- The branch included a mock filesystem direction; the concept is correct and should be made complete enough for backend tools and app services instead of relying on real workspace files.

Ideas to avoid or rework:

- Do not hardcode the mock provider into normal provider discovery.
- Do not use unseeded `Math.random()`.
- Do not make the user-visible prompt text carry hidden control instructions at all.
- Do not implement a partial mock filesystem and assume all filesystem effects are covered; the backend mock filesystem must be a first-class simulation service with explicit unsupported-operation failures.

## Core Design Decision: Endpoint Control, Not Prompt Control

The primary harness should control backend behavior through a test-only simulation control endpoint or in-process control service. The TUI should then submit ordinary prompt text through the normal UI.

This is better than embedding control data in the prompt because:

- It keeps prompt contents realistic, so prompt UI behavior can be tested independently from backend scripting.
- It keeps transcripts and message history understandable.
- It works for non-prompt workflows like command palette actions, session summarization, permission flows, shell mode, model switching, and future MCP controls.
- It lets the runner prepare backend state before the next UI action.
- It gives us a natural place to force future backend state, such as MCP state, tool results, filesystem state, provider errors, and pending permission/question state.
- It makes replay traces explicit: `control.enqueueLLM(...)`, then `ui.submitPrompt(...)`.

There should be no JSON-in-prompt fallback. If no endpoint-enqueued script matches a model request, the mock LLM should fail with a clear simulation error. This keeps user-visible prompt text realistic and makes replay traces explicit.

## High-Level Architecture

The system has five layers:

1. Simulation backend services.
2. TUI driver and observation harness.
3. Semantic UI and backend graph builder.
4. Property runner, generator, replay, and shrinker.
5. Later DST controls for clock, timers, schedulers, and async ordering.

The initial runner loop should look like this:

```text
seed -> start isolated backend -> mount TUI -> observe state
repeat N times:
  choose next UI action from current semantic state
  optionally enqueue backend script/control data
  execute the UI action
  wait for quiescence
  record UI/backend/network/event observations
  run relevant properties
  update semantic graph
on failure:
  persist replay trace and human-readable report
```

## Simulation Backend Services

### Production App With Narrow Overrides

The runner should load the normal app by default. Avoid building a separate test route tree or installing a broad graph of mock services. The goal is to run production wiring and only override the few core effect boundaries that must be deterministic.

The first required override is `AppFileSystem.Service`, so backend-visible files come from the in-memory mock filesystem. Other overrides should be added only when the app cannot be controlled through configuration, the simulation control endpoint, or the sandbox policy.

Possible narrow shape:

```ts
// Conceptual API, not final names.
export function createRoutes(input?: {
  cors?: CorsOptions
  overrides?: {
    appFileSystem?: Layer.Layer<AppFileSystem.Service>
  }
}) {
  return productionRoutesWithProductionServices(input)
}
```

The important part is not the exact type. The important part is that simulation mode should not need to re-provide provider, MCP, tool registry, network, or most backend services. It should load the whole app and make the smallest viable changes, starting with the filesystem boundary.

### Simulation Control State

Add simulation-only control state that owns deterministic run state. This is not a replacement for app services; it is the small state store used by control endpoints and the mock provider.

Proposed source location:

- `packages/opencode/src/testing/simulation/service.ts`
- `packages/opencode/src/testing/simulation/provider.ts`
- `packages/opencode/src/testing/simulation/filesystem.ts`
- `packages/opencode/src/testing/simulation/httpapi.ts`
- `packages/opencode/src/testing/simulation/network.ts`
- `packages/opencode/src/testing/simulation/runner.ts`

The service should be instance-scoped where possible and keyed by a `runID`.

Core responsibilities:

- Hold seeded RNG state.
- Hold queued LLM scripts.
- Hold mock filesystem state.
- Record UI action IDs, backend request IDs, events, tool calls, and state changes.
- Enforce network policy.
- Provide snapshots for replay/failure reports.
- Reset state between runs.

Conceptual control API:

```ts
type SimulationControl = {
  reset(input: { runID: string; seed: string }): Effect.Effect<void>
  enqueueLLM(input: { runID: string; match?: LLMScriptMatch; script: LLMScript }): Effect.Effect<void>
  snapshot(input: { runID: string }): Effect.Effect<SimulationSnapshot>
  recordAction(input: UIActionRecord): Effect.Effect<void>
  recordRequest(input: BackendRequestRecord): Effect.Effect<void>
  recordEvent(input: BackendEventRecord): Effect.Effect<void>
}
```

### Control Endpoint

Add a gated endpoint under the instance HTTP API, probably `/experimental/simulation/*`.

Suggested endpoints:

- `POST /experimental/simulation/reset`
- `POST /experimental/simulation/llm/enqueue`
- `GET /experimental/simulation/snapshot`
- `POST /experimental/simulation/action/start`
- `POST /experimental/simulation/action/end`

Access should be impossible in normal production use unless explicit simulation mode is enabled. If the endpoint is added to the typed HttpApi surface, regenerate the JS SDK with `./packages/sdk/js/script/build.ts`. The runner can also call the endpoint with raw fetch to avoid making this a public user-facing API.

### Mock LLM Provider

The main LLM mock should be a real provider/model path, not a replacement for `SessionPrompt` or a wholesale replacement of `Provider.Service`.

Preferred seam:

- Register or configure a local simulation provider/model through the normal provider system.
- Implement its language model with an AI SDK-compatible mock language model adapted to the current AI SDK version.
- Let the existing `LLM.Service` call `streamText(...)`, process tools, and emit normal stream events.

This preserves more of the real backend path than replacing `LLM.Service` or `Provider.Service` directly.

The mock model should read the next script from `Simulation.Service` using request context:

- `runID`
- `sessionID`
- `messageID` or last user message ID
- model/provider ID
- tool round number

If no endpoint-enqueued script matches, the mock model should fail with a typed simulation error that includes the run ID, session ID, model, and tool round. Silent default responses and prompt parsing would hide missing runner setup.

Script action schema:

```ts
type LLMScriptAction =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; name: string; input: Record<string, unknown> }
  | { type: "list_tools" }
  | { type: "error"; message: string }

type LLMScript = {
  steps: LLMScriptAction[][]
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  finish?: "stop" | "tool-calls" | "error" | "length" | "unknown"
}
```

Keep the old rule that step `0` runs before tool results and step `N` runs after `N` tool-result rounds. The endpoint-backed service should also record which script step was consumed so replay reports are explicit.

### Database, Filesystem, Tools, MCP, And Network

Initial policy:

- Force `OPENCODE_DB=:memory:` for the simulation backend process. This should be a hard simulation-mode invariant, not a per-test preference.
- Run the app/backend under macOS `sandbox-exec` by default for local simulation runs, following the old branch's technique: deny external network, deny host filesystem writes, and only allow the minimum paths needed to boot the process and communicate over loopback/in-process transports.
- Add a first-class backend mock filesystem and provide it by overriding `AppFileSystem.Service` instead of relying on a real temp workspace for app-visible files.
- Use the normal provider system with a local simulation provider/model; do not replace `Provider.Service` unless a later implementation proves a small seam is unavoidable.
- Keep MCP on the normal app path and disable/configure it by default so it starts no network or child processes. Add narrow MCP controls later only for tests that explicitly target MCP states.
- Use sandbox/network guards to reject non-loopback network. Only override `HttpClient.HttpClient` if a minimal core override is needed to make failures typed and observable.
- Disable or fake webfetch, websearch, share, update, repo clone, and other external tools through normal config/tool policy where possible.
- Run read/glob/grep/write/edit against the mock filesystem, not the host filesystem.
- Treat bash/shell execution as opt-in and fake it by default, because real process execution bypasses the mock filesystem and sandbox policy is the last line of defense.

Later policy:

- Add deterministic fake child process and shell tools.
- Add deterministic fake LSP/file-watcher events.

The mock filesystem should be authoritative for backend-visible project files. The host filesystem should only be used for runner artifacts, bundled source/config needed to start the app, and sandbox-allowed runtime plumbing. Any app path that escapes the mock filesystem should fail with a typed simulation error so missing coverage is obvious.

### In-Memory Database

Simulation mode should set the database to memory globally for the backend process:

```text
OPENCODE_DB=:memory:
```

This must happen before any import path evaluates `storage/db.ts`, because `Database.Path` is computed at module load. The simulation bootstrap should own process startup so this cannot be missed. Each run should start from an empty DB and seed any required sessions/state through public services or simulation controls.

### Sandbox Isolation

The local runner should reuse the old branch's `sandbox-exec` setup on macOS as the starting implementation. Specifically, adapt `jlongster/fuzz-backend:packages/opencode/src/provider/sdk/mock/sandbox.sb` and `jlongster/fuzz-backend:packages/opencode/src/provider/sdk/mock/run` into the new simulation runner layout.

The old setup did the right first-order thing:

- `sandbox-exec -f ... -D HOME=$HOME bun --preload ... src/index.ts serve`
- Start from `(allow default)` so the process can boot.
- Deny all network with `(deny network*)`.
- Re-allow localhost network for local server/TUI communication.
- Deny all filesystem writes with `(deny file-write*)`.
- Deny reads from sensitive user config/state directories like `$HOME/.local` and `$HOME/.config`.

The sandbox is not the primary abstraction for deterministic behavior; it is the safety boundary that proves missed hooks cannot touch the host filesystem or external network.

Initial sandbox policy should stay close to the old branch:

- Deny outbound network except loopback when a real listener is used.
- Deny host filesystem writes inside the sandbox. The parent runner can write trace artifacts outside the sandbox after collecting them over stdout, HTTP, or another explicit control channel.
- Deny reads from user config/state locations unless explicitly mounted as test fixtures.
- Fail fast when a denied operation happens so the trace records a simulation escape.

The mock filesystem and network guards should still exist inside the app. `sandbox-exec` catches leaks; it should not be the mechanism that normal simulated I/O depends on.

### Backend Mock Filesystem

The mock filesystem should be implemented as a real simulation service, not as test fixture files on disk.

Responsibilities:

- Store files, directories, symlinks if needed, executable bits if needed, mtimes, and binary/text content in memory.
- Provide deterministic path resolution for workspace root, current directory, home, config, state, and temp paths.
- Expose operations needed by `AppFileSystem.Service`, read/write/edit tools, glob/grep/ripgrep equivalents, config reads, snapshot/diff, and prompt file attachment resolution.
- Emit deterministic file change/snapshot events when writes happen.
- Make unsupported operations fail explicitly with typed simulation errors.
- Support seeding initial file trees from JSON fixtures and serializing filesystem state into replay traces.

Implementation should prefer a narrow `AppFileSystem.Service` override first. If file/ripgrep services or filesystem tools bypass that boundary, make the smallest targeted change to route them through the mock filesystem rather than replacing the whole tool registry. If some backend paths still import `@/util/filesystem` or direct host filesystem APIs, use the same Bun preload/plugin technique from the old branch to redirect those imports in simulation mode. The sandbox should then catch any remaining direct `fs`, `Bun.file`, or child-process access that was not routed through the mock filesystem.

### Backend Quiescence

The first useful quiescence definition should be pragmatic:

- No session has `session.status.type === "busy"`.
- The TUI sync queue has flushed.
- The runner has seen all events produced by the current action.
- The renderer has completed at least one frame after the last event.
- No pending simulation-controlled LLM stream or tool call remains.

This is not full DST yet. It is enough to avoid racing the next action against obvious async work.

## TUI Driver And Observation Harness

### Harness Injection

Do not add another hardcoded environment-runner component like the old `Mock` component. Instead, extend `tui(...)`/`App` with an optional test harness hook.

Conceptual shape:

```ts
export function tui(input: {
  url: string
  args: Args
  config: TuiConfig.Resolved
  fetch?: typeof fetch
  events?: EventSource
  testing?: TuiHarness.Input
})
```

The `App` can mount a tiny `TuiHarnessProbe` only when `testing` is provided. The probe exposes the same kinds of context that `plugin/api.tsx` already gathers:

- route
- keymap
- prompt ref
- sync state
- SDK client
- renderer
- dialog state
- KV state
- event bus
- local model/agent state

This gives tests a stable internal API without coupling to a specific visible component.

### Driver Modes

Start with two modes:

- Semantic in-process mode: uses context APIs, keymap commands, prompt refs, SDK fetch wrappers, and renderer snapshots. This is the main property runner.
- Terminal/PTY mode: later, spawn the real binary in a PTY, inject bytes, and read terminal snapshots. This catches lower-level terminal regressions but is slower.

The semantic mode should still exercise OpenTUI rendering, Solid state, keymap registration, SDK calls, backend routes, SSE/events, and prompt submit flows.

### Action Types

Initial action types:

```ts
type UIAction =
  | { type: "command"; command: string }
  | { type: "prompt.set"; text: string }
  | { type: "prompt.submit"; text?: string; llm?: LLMScript }
  | { type: "key"; key: string; modifiers?: string[] }
  | { type: "paste"; text: string }
  | { type: "click"; elementID: string }
  | { type: "wait"; condition: "idle" | "frame"; timeoutMs: number }
```

The runner should prefer semantic commands first. Raw key and mouse actions are useful, but command-level actions are easier to shrink and replay.

### Observation Types

Every action should record before/after observations:

```ts
type UIObservation = {
  route: unknown
  dialogDepth: number
  focusedElement?: string
  semanticElements: SemanticElement[]
  bufferHash?: string
  visibleText?: string
  syncSummary: SyncSummary
  errors: SimulationError[]
}
```

Initial `visibleText` can come from renderer/test-render snapshots where available. Later PTY mode should capture the terminal buffer directly.

### TUI State Changers To Track

Frontend state can change because of:

- Keyboard events.
- Mouse events.
- Paste and IME submit deferrals.
- Terminal resize and theme detection.
- SDK HTTP responses.
- SDK event stream messages.
- Timers used for batching, focus, prompt submit, animations, retry, and placeholders.
- Local KV, prompt history, prompt stash, model recents/favorites.
- Plugin registration, routes, slots, commands, events, and toasts.
- Clipboard/selection flows.
- Process signals and terminal suspend/resume.

The first runner does not need full control over all of these. It should record them when they occur and gradually move high-impact sources under simulation control.

## Semantic UI Graph

### Semantic Registry

Add a TUI semantic registry that components can use to announce interactive elements and available actions.

Conceptual element shape:

```ts
type SemanticElement = {
  id: string
  role: "prompt" | "command" | "dialog" | "dialog-option" | "permission" | "question" | "message" | "route"
  label: string
  enabled: boolean
  visible: boolean
  state?: Record<string, unknown>
  bounds?: { x: number; y: number; width: number; height: number }
  actions: SemanticAction[]
}
```

First components to instrument:

- `Prompt` for text input, submit, shell mode, slash commands, file/agent attachments.
- App commands registered in `app.tsx`.
- Prompt commands registered in `component/prompt/index.tsx`.
- `DialogSelect` for option movement/filter/select.
- Permission and question overlays.
- Route state in `RouteProvider`.
- Session message parts, especially tool and error parts.

This should be additive metadata. It should not change rendering behavior.

### Graph Shape

The graph should abstract states instead of storing every concrete UI snapshot.

```ts
type SemanticState = {
  id: string
  route: string
  dialog?: string
  elementSignature: string
  backendSignature?: string
}

type SemanticTransition = {
  id: string
  from: string
  to: string
  action: UIAction
  uiChanged: string[]
  backendRequests: BackendRequestRecord[]
  backendEvents: BackendEventRecord[]
  coverage: string[]
  failures: SimulationFailure[]
}
```

State hashing should initially normalize volatile IDs/timestamps. As deterministic IDs/clocks land, less normalization will be needed.

### Discovery Pass

The discovery runner randomly chooses from currently available semantic actions, executes them, observes transitions, and writes a graph artifact.

Suggested output:

- `.opencode/simulation/ui-graph.json`
- `.opencode/simulation/backend-graph.json`
- `.opencode/simulation/runs/<runID>.jsonl`

The graph is not expected to be perfect. It should answer practical questions:

- What actions are available from each abstract UI state?
- Which actions produce backend requests?
- Which actions open dialogs, create sessions, request permissions, create tool parts, or show errors?
- Which action sequences reach the prompt, session, permission, question, model selection, MCP, and session list states?

### Directed Runner

After discovery, the directed runner should use the graph to bias generation toward requested targets.

Examples:

- "Focus prompt submit with tool calls."
- "Exercise permission approve/reject flows."
- "Exercise session list and route changes."
- "Exercise backend prompt_async and SessionPrompt loop states."

The directed runner can plan a route through the graph to a target state, then run generated variants from there.

## Mapping UI Actions To Backend Requests

Every generated action should have an `actionID`.

The TUI fetch wrapper should add headers:

- `x-opencode-simulation-run`
- `x-opencode-simulation-action`
- `x-opencode-simulation-step`

The backend should record request spans:

```ts
type BackendRequestRecord = {
  runID: string
  actionID?: string
  requestID: string
  method: string
  path: string
  endpoint?: string
  status: number
  startedAt: number
  endedAt: number
}
```

Async work needs explicit correlation. For example, `prompt_async` returns before the session run finishes. The handler should attach the current `actionID` to the created user message/session run in `Simulation.Service`, so later LLM/tool/session events can be attributed to the same UI action.

Backend events should also be recorded:

```ts
type BackendEventRecord = {
  runID: string
  actionID?: string
  eventID: string
  type: string
  sessionID?: string
  messageID?: string
  domains: string[]
}
```

This gives the graph the important edge information: UI action -> HTTP request -> backend state/event changes -> TUI sync changes.

## Backend Semantic Analysis

Backend semantic analysis should start from cheap instrumentation:

- HTTP endpoint entry/exit.
- Bus/SyncEvent publications.
- Session status changes.
- Message and part writes.
- Permission and question asks/replies.
- Tool start/finish/error.
- LLM stream start/finish/error.

The first backend state domains:

- `session`
- `message`
- `part`
- `permission`
- `question`
- `todo`
- `tool`
- `mcp`
- `filesystem`
- `network`
- `status`

Later, add DB snapshots or table-level hashes for deeper invariants. Do not read and diff the whole database after every action until we know it is needed.

## Property API

Properties should be ordinary TypeScript functions registered with the runner.

Conceptual API:

```ts
type Property = {
  name: string
  domains: string[]
  check: (ctx: PropertyContext) => Promise<void>
}
```

`domains` lets the runner skip checks when unrelated state changed.

Example properties:

```ts
property({
  name: "app.does-not-crash",
  domains: ["tui", "backend"],
  async check(ctx) {
    ctx.expect(ctx.tui.errors).toEqual([])
    ctx.expect(ctx.backend.errors).toEqual([])
  },
})
```

Built-in properties for pass one:

- The app does not crash. This includes uncaught TUI render errors and unhandled backend failures caused by the generated action.

Later properties:

- No non-loopback network call.
- Session eventually becomes idle after prompt-like actions.
- No pending tool call remains after idle.
- Every TUI-visible session message has valid message/part schemas.
- Permission/question overlays correspond to backend pending requests.
- Replay trace can be parsed and rerun.
- Text should not flicker across stable frames.
- Dialog focus should remain valid.
- Route state and visible route agree.
- Backend DB invariants hold after every endpoint group.
- Tool call lifecycle events are balanced.
- No generated action sequence can strand a session in busy state.

## Failure Reports And Replay

On failure, persist a trace and a concise report.

Trace should include:

- Seed and run configuration.
- Initial mock filesystem fixture and workspace/config path mapping.
- Simulation control calls.
- UI action sequence.
- LLM scripts consumed.
- HTTP request records.
- Backend events.
- UI observations before/after each action.
- Property checks and failure details.
- Normalization version.

Human report should include:

- Failed property name.
- Seed and action index.
- Minimal replay command.
- The last N UI actions.
- The backend requests/events caused by the failing action.
- Visible TUI text/buffer before and after.
- Any session/message/tool IDs relevant to the failure.

Initial replay can simply rerun the exact trace. Shrinking can come later.

Shrinking plan:

- Delete contiguous chunks of actions.
- Reduce generated prompt text.
- Reduce LLM scripts to fewer actions/steps.
- Prefer semantic action shrinking over raw key shrinking.
- Preserve explicit control calls needed to reproduce backend state.

## DST Roadmap

Full deterministic simulation testing requires more than seeded random actions. It requires control over time and async scheduling. Build this gradually.

### Stage 1: Record And Normalize

- Seed RNG for the runner.
- Normalize timestamps and generated IDs in traces.
- Record timer registrations and delayed events where easy.
- Use quiescence waits instead of fake time.

### Stage 2: Deterministic Data Sources

- Add deterministic ID generation behind an injectable service or simulation mode.
- Replace `Math.random()` usage in TUI placeholders/tests with seeded RNG in simulation mode.
- Replace provider, MCP, network, and unsafe tools with deterministic services.

### Stage 3: Controlled Clock

- Move high-impact backend `Date.now()` call sites to Effect clock/time services.
- Add a simulation clock service.
- Let the runner advance logical time.

### Stage 4: Controlled Timers And Event Loop

- Wrap TUI timer use through a scheduler service where practical.
- Expose SDK event batching timers to the harness.
- Let the runner advance timers as part of quiescence.

### Stage 5: Async Interleaving Exploration

- Randomize or systematically vary ordering of queued events, LLM chunks, tool completions, and sync flushes.
- Replay exact interleavings from traces.

## Implementation Passes

### Pass 1: Backend-Only Deterministic Prompt Runner

Deliverables:

- Local mock LLM provider/model registered through the normal provider path.
- Simulation control state and raw or typed control endpoint.
- Sandboxed backend runner that loads the normal app and applies only narrow core overrides, starting with `AppFileSystem.Service`.
- Process bootstrap that forces `OPENCODE_DB=:memory:` before backend modules load.
- Initial backend mock filesystem service with seeded fixture support.
- macOS `sandbox-exec` runner wrapper that denies external network and host filesystem access.
- Seeded generation of LLM scripts based on available tools.
- Replay trace for backend-only prompt runs.

Scope:

- Create session.
- Seed mock filesystem contents.
- Enqueue LLM script.
- Call `prompt_async`.
- Wait for idle over events.
- Assert basic backend properties.

Validation:

- Run 10 to 100 generated backend prompt cases without external network.
- Prove filesystem reads/writes hit the mock filesystem and not the host filesystem.
- Prove tool-call, text, reasoning, and error scripts hit the real `SessionPrompt` and `SessionProcessor` path.

### Pass 2: TUI Prompt Smoke Runner

Deliverables:

- Optional `testing` hook in `tui(...)`/`App`.
- In-process TUI harness exposing prompt ref, route, sync, keymap, SDK, and renderer.
- Fetch/event wrappers that add simulation action headers and record requests/events.
- A runner action that enqueues LLM script, sets prompt text through TUI, submits, waits for idle, and checks no crash.

Scope:

- Prompt input and submit only.
- Normal text and one tool-call script.
- Real backend, fake external services.

Validation:

- Run TUI -> prompt -> backend -> LLM script -> tool/result -> TUI message display.
- Persist and replay a trace.

### Pass 3: Semantic UI Registry

Deliverables:

- `TuiSemanticProvider` and registry API.
- Instrument prompt, app commands, prompt commands, route state, dialog select, permission, and question components.
- Snapshot current semantic elements from the harness.
- Random semantic action generator.

Scope:

- Commands, prompt text/submit, dialog option select, permission approve/reject, question answer/reject.

Validation:

- Generate random semantic actions for a fixed number of steps.
- Build a small UI transition graph.
- Replay any generated sequence.

### Pass 4: Directed Property Runner

Deliverables:

- Property registration API.
- Domain-based property filtering.
- Built-in no-crash/no-network/session-idle/tool-lifecycle properties.
- Directed generation targets based on semantic graph.

Scope:

- User asks for a focus area and iteration/depth count.
- Runner biases actions toward graph paths related to that area.

Validation:

- `prompt submit with tool calls` target produces many prompt/tool/session variants.
- `permission flows` target reaches permission UI and exercises approve/reject.

### Pass 5: Backend Graph And Endpoint Mapping

Deliverables:

- Request and event correlation by action ID.
- Backend domain change records.
- Endpoint/action graph export.
- Basic backend state signatures.

Scope:

- Session, message, part, permission, question, todo, tool, and status domains.

Validation:

- Given a UI action, report which backend endpoints and state domains changed.
- Given a backend endpoint/domain, report UI actions that reached it.

### Pass 6: Determinism Hardening

Deliverables:

- Seeded RNG everywhere in the runner.
- Deterministic ID/time mode for high-impact backend paths.
- Timer registration recording.
- More complete network/process guards.
- Complete backend mock filesystem coverage for configured filesystem tools and app services.

Scope:

- Reduce trace normalization.
- Make failures replay reliably across machines.

Validation:

- Same seed and trace produce same observations modulo approved volatile fields.

### Pass 7: Shrinking And Differential Runs

Deliverables:

- Action sequence shrinker.
- Prompt/script shrinker.
- Dual-run differential runner similar in spirit to the old branch.
- Stable normalization rules for diff output.

Scope:

- Compare current branch against baseline or two configurations.

Validation:

- Induced failure shrinks to a short reproducible action trace.
- Differential runner reports meaningful semantic diffs, not timestamp/ID noise.

## Suggested Initial File Layout

```text
packages/opencode/src/testing/simulation/service.ts
packages/opencode/src/testing/simulation/provider.ts
packages/opencode/src/testing/simulation/filesystem.ts
packages/opencode/src/testing/simulation/httpapi.ts
packages/opencode/src/testing/simulation/network.ts
packages/opencode/src/testing/simulation/mcp.ts
packages/opencode/src/testing/simulation/tool-registry.ts
packages/opencode/src/testing/simulation/sandbox.sb
packages/opencode/src/testing/simulation/run.ts
packages/opencode/src/cli/cmd/tui/testing/harness.tsx
packages/opencode/src/cli/cmd/tui/testing/semantic.tsx
packages/opencode/test/property/backend-runner.test.ts
packages/opencode/test/property/tui-runner.test.ts
packages/opencode/test/property/properties.ts
packages/opencode/test/property/generator.ts
```

If we want the harness code completely out of production bundles, keep more of it under `test/property`. The server route, TUI optional hook, and any simulation-gated services that the app imports need to live under `src`.

## Open Questions To Resolve During Implementation

- Should the simulation endpoint be a typed HttpApi route that regenerates SDK, or an internal raw route used only by the runner?
- Should the first mock model target the current AI SDK provider interface directly, or temporarily fake `LLM.Service` while the provider mock is adapted?
- How much renderer tree metadata does OpenTUI expose for stable bounds and visible text snapshots?
- Which tools should be enabled by default in generation: read/glob/grep/todo only, or write/edit against the mock filesystem too?
- Where should trace artifacts live by default so they are easy to inspect but not accidentally committed?

## Recommended Starting Point

Start with Pass 1 and Pass 2.

The smallest useful end-to-end test is:

1. Start an isolated backend under `sandbox-exec` with `OPENCODE_DB=:memory:`, simulation provider, fake MCP, guarded network, and seeded mock filesystem.
2. Mount the TUI with a harness hook and in-process fetch/event transport.
3. Enqueue an LLM script through simulation control.
4. Set the prompt to ordinary text like `hello` and submit through `PromptRef`.
5. Wait for session idle and TUI sync.
6. Assert no TUI/backend errors and that the expected assistant text/tool part appears.
7. Persist a replay trace containing the seed, control call, UI action, requests, events, and observations.

This gives immediate value while leaving room for semantic graph discovery, directed properties, failure shrinking, and true DST controls later.
