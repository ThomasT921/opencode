# 02 Semantic Discovery

Status: speculative. Refine before implementation.

This phase starts after the first-pass action generator can drive the TUI and assert that the app does not crash.

## Goal

Build a semantic map of TUI states, available actions, backend requests, and backend state changes. This lets later runs focus on workflows instead of random screen poking.

## UI Semantics

We need a way to know what the runner can interact with on the current screen.

Preferred order:

- Use OpenTUI render tree/fake renderer APIs if they expose interactable elements.
- Add a small TUI semantic registry only for missing metadata.
- Avoid large per-component instrumentation at first.

Potential semantic element shape:

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

## Backend Mapping

Every generated UI action should have an action ID. TUI requests should include simulation headers so backend observations can be correlated.

Headers:

- `x-opencode-simulation-run`
- `x-opencode-simulation-action`
- `x-opencode-simulation-step`

Record requests and events with enough metadata to answer:

- Which UI actions produced which backend requests?
- Which backend domains changed?
- Which TUI states became reachable?
- Which generated path caused the crash if a crash happens?

Backend domains to consider later:

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

## Graph Shape

The graph should abstract states rather than storing every concrete buffer.

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
  failures: SimulationFailure[]
}
```

## Todos

- [ ] Reassess OpenTUI APIs after first-pass fake renderer work.
- [ ] Decide whether a TUI semantic registry is needed.
- [ ] Add action IDs to generated actions.
- [ ] Add action headers to TUI fetch wrapper.
- [ ] Record backend request spans.
- [ ] Record backend events and changed domains.
- [ ] Define normalized UI state signatures.
- [ ] Build first UI transition graph artifact.
- [ ] Build first backend endpoint/domain graph artifact.
- [ ] Use graph to bias action generation toward a selected workflow.
