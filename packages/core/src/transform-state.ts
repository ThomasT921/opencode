export * as TransformState from "./transform-state"

import { Effect, Scope, Semaphore } from "effect"
import { createDraft, finishDraft, type Draft, type Objectish } from "immer"

export type Transform<Editor> = (editor: Editor) => void
export type MakeEditor<State extends Objectish, Editor> = (draft: Draft<State>) => Editor
export type SetTransform<Editor> = (transform: Transform<Editor>) => Effect.Effect<void>

export interface Options<State extends Objectish, Editor> {
  readonly initial: () => State
  readonly editor: MakeEditor<State, Editor>
  /** Applies service-specific work during a full rebuild. */
  readonly rebuild?: (editor: Editor) => Effect.Effect<void>
  /** Applies invariants to every committed edit, including incremental edits. */
  readonly finalize?: (editor: Editor) => Effect.Effect<void>
}

export interface Interface<State extends Objectish, Editor> {
  readonly get: () => State
  readonly transform: () => Effect.Effect<SetTransform<Editor>, never, Scope.Scope>
  readonly update: (update: (editor: Editor) => Effect.Effect<void>) => Effect.Effect<void>
}

export function create<State extends Objectish, Editor>(options: Options<State, Editor>): Interface<State, Editor> {
  let state = options.initial()
  let transforms: { update: Transform<Editor> }[] = []
  const semaphore = Semaphore.makeUnsafe(1)

  const commit = Effect.fn("TransformState.commit")(function* (draft: Draft<State>) {
    const api = options.editor(draft)
    if (options.finalize) yield* options.finalize(api)
    state = finishDraft(draft) as State
  })

  const rebuild = Effect.fn("TransformState.rebuild")(function* () {
    const draft = createDraft(options.initial())
    const api = options.editor(draft)
    for (const transform of transforms) transform.update(api)
    if (options.rebuild) yield* options.rebuild(api)
    yield* commit(draft)
  }, semaphore.withPermit)

  return {
    get: () => state,
    transform: Effect.fn("TransformState.transform")(function* () {
      const transform = { update: (_editor: Editor) => {} }
      transforms = [...transforms, transform]
      const scope = yield* Scope.Scope
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          transforms = transforms.filter((item) => item !== transform)
        }).pipe(Effect.andThen(rebuild())),
      )
      return Effect.fnUntraced(function* (update: Transform<Editor>) {
        transform.update = update
        yield* rebuild()
      })
    }),
    update: Effect.fn("TransformState.update")(function* (update) {
      const draft = createDraft(state)
      yield* update(options.editor(draft))
      yield* commit(draft)
    }, semaphore.withPermit),
  }
}
