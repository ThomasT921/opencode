# 04 DST Hardening

Status: speculative. Refine before implementation.

This phase moves from seeded generation plus replay toward deterministic simulation testing. Do not start here; first get the app running under the first-pass simulation environment.

## Stage 1: Record And Normalize

- Seed RNG for the runner.
- Normalize timestamps and generated IDs in traces.
- Record timer registrations and delayed events where easy.
- Use quiescence waits instead of fake time.

## Stage 2: Deterministic Data Sources

- Add deterministic ID generation behind a narrow simulation mode if normalization becomes too noisy.
- Replace `Math.random()` usage in simulation-facing paths with seeded RNG.
- Keep provider, filesystem, and network deterministic through the first-pass simulation boundaries.

## Stage 3: Controlled Clock

- Move high-impact backend `Date.now()` call sites to Effect clock/time services where practical.
- Add a simulation clock service.
- Let the runner advance logical time.

## Stage 4: Controlled Timers And Event Loop

- Wrap TUI timer use through a scheduler service where practical.
- Expose SDK event batching timers to the harness.
- Let the runner advance timers as part of quiescence.

## Stage 5: Async Interleaving Exploration

- Randomize or systematically vary ordering of queued events, LLM chunks, tool completions, and sync flushes.
- Replay exact interleavings from traces.

## Differential Runs

Later, reuse the useful idea from the old branch's differential runner:

- Run the same trace against two app versions or two configurations.
- Normalize volatile fields.
- Report semantic diffs instead of timestamp/ID noise.

## Todos

- [ ] Define which nondeterminism remains after first-pass replay.
- [ ] Decide whether deterministic IDs are needed or trace normalization is enough.
- [ ] Identify highest-impact `Date.now()` call sites.
- [ ] Design a minimal simulation clock only if needed.
- [ ] Design timer control only after fake renderer/action runner behavior is stable.
- [ ] Add differential runner after trace replay is reliable.
