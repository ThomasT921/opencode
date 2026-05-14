# 05 Reference Notes

Status: reference material. Keep this short and update as implementation discovers new seams.

## Current TUI Map

- `packages/opencode/src/cli/cmd/tui/thread.ts`: starts the TUI worker and in-process transport.
- `packages/opencode/src/cli/cmd/tui/app.tsx`: creates the OpenTUI renderer/keymap and renders the Solid app.
- `packages/opencode/src/cli/cmd/tui/context/sdk.tsx`: SDK client, custom fetch, event source, event batching.
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx`: projects backend events into TUI state.
- `packages/opencode/src/cli/cmd/tui/context/route.tsx`: route state.
- `packages/opencode/src/cli/cmd/tui/context/prompt.tsx`: current prompt ref.
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`: prompt input and submit path.
- `packages/opencode/src/cli/cmd/tui/keymap.tsx`: base keymap registration and `useBindings` exports.
- `packages/opencode/src/cli/cmd/tui/plugin/api.tsx`: useful model for harness context exposure.

## Current Backend Map

- `packages/opencode/src/server/server.ts`: exposes `Server.Default().app.request(...)`.
- `packages/opencode/src/server/routes/instance/httpapi/server.ts`: route tree and production layers.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`: prompt/prompt_async/session endpoints.
- `packages/opencode/src/session/prompt.ts`: real prompt loop, tool resolution, LLM orchestration.
- `packages/opencode/src/session/llm.ts`: provider language model seam and `streamText(...)` call.
- `packages/opencode/src/provider/provider.ts`: normal provider discovery/loading path.
- `packages/opencode/src/mcp/index.ts`: MCP network/process seam.
- `packages/opencode/src/tool/registry.ts`: built-in and plugin tool registry.
- `packages/opencode/src/storage/db.ts`: `OPENCODE_DB` and `:memory:` support.
- `packages/opencode/src/id/id.ts`: timestamp/random ID generation.

## Prior Branch Notes

Branch: `jlongster/fuzz-backend`.

Useful ideas to reuse:

- Mock AI SDK provider emitted real language-model stream chunks.
- Compact LLM script action format worked well.
- Step selection by counting tool-result rounds worked well.
- HTTP/SSE backend runner waited for `session.status` idle.
- Tool discovery and schema-shaped fake input generation were useful.
- TUI runner used internal prompt ref to submit scripted prompts.
- Differential runner normalized volatile fields and compared runs.
- SQLite was forced to `:memory:`.
- `sandbox-exec` denied external network and host filesystem access.
- Bun preload/plugin direction can catch imports that bypass service boundaries.

Things to avoid:

- No JSON-in-prompt protocol or fallback.
- No unseeded `Math.random()` in generated actions.
- No partial mock filesystem that silently falls back to host FS.
- No broad replacement of app service graph when a narrow override works.

## Old Sandbox Setup

Starting files on prior branch:

- `packages/opencode/src/provider/sdk/mock/sandbox.sb`
- `packages/opencode/src/provider/sdk/mock/run`

Important behavior:

- `sandbox-exec -f ... -D HOME=$HOME bun --preload ... src/index.ts serve`
- `(allow default)` so the process can boot.
- `(deny network*)` with localhost re-allowed.
- `(deny file-write*)`.
- Deny reads from `$HOME/.local` and `$HOME/.config`.

Adapt this setup into the new simulation runner layout rather than inventing a new sandbox policy first.
