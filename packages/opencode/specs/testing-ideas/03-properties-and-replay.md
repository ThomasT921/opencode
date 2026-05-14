# 03 Properties And Replay

Status: speculative. Refine before implementation.

The first pass only checks that the app does not crash. Add more properties only after the basic runner and traces are stable.

## Property API

Properties should be ordinary TypeScript functions registered with the runner.

```ts
type Property = {
  name: string
  domains: string[]
  check: (ctx: PropertyContext) => Promise<void>
}
```

The `domains` field lets the runner skip checks when unrelated state changed.

First pass property:

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

Later candidate properties:

- No non-loopback network call.
- Session eventually becomes idle after prompt-like actions.
- No pending tool call remains after idle.
- Every TUI-visible session message has valid message/part schemas.
- Permission/question overlays correspond to backend pending requests.
- Replay trace can be parsed and rerun.
- Text should not flicker across stable frames.
- Dialog focus should remain valid.
- Route state and visible route agree.
- Backend DB invariants hold after endpoint groups.
- Tool call lifecycle events are balanced.
- No generated action sequence can strand a session in busy state.

## Failure Reports

Failure reports should be human-readable and point to the smallest useful context.

Report fields:

- Failed property name.
- Seed and action index.
- Minimal replay command.
- Last N UI actions.
- Backend requests/events caused by the failing action.
- Visible TUI buffer before and after.
- Relevant session/message/tool IDs.

## Replay Trace

Trace fields:

- Seed and run configuration.
- Mock filesystem fixture and workspace/config path mapping.
- Mock network schema registrations.
- Simulation control calls.
- LLM scripts consumed.
- UI action sequence.
- HTTP request records.
- Backend events.
- UI observations before/after each action.
- Property checks and failure details.
- Normalization version.

## Shrinking

Shrinking should come after exact replay is reliable.

Candidate shrink steps:

- Delete contiguous chunks of actions.
- Reduce generated prompt text.
- Reduce LLM scripts to fewer actions/steps.
- Prefer semantic action shrinking over raw key shrinking.
- Preserve control calls needed to reproduce backend state.

## Todos

- [ ] Keep first pass to `app.does-not-crash` only.
- [ ] Define trace JSON schema after first runner exists.
- [ ] Write replay command that reruns an exact trace.
- [ ] Add readable failure report formatter.
- [ ] Add network property after mock network is stable.
- [ ] Add session/tool lifecycle properties after backend mapping is stable.
- [ ] Add shrinker only after replay is deterministic.
