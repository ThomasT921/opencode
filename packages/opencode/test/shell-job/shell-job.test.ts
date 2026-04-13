import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"

import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "../../src/filesystem"
import { Instance } from "../../src/project/instance"
import { ShellJob } from "../../src/shell-job"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    ShellJob.layer.pipe(Layer.provide(CrossSpawnSpawner.defaultLayer), Layer.provide(AppFileSystem.defaultLayer)),
  ),
)

const node = (script: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("shell-job", () => {
  it.live("captures output and persists spool files", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const jobs = yield* ShellJob.Service
        const job = yield* jobs.start({
          command: node('process.stdout.write("ok")'),
          cwd: dir,
          title: "ok",
        })
        const done = yield* jobs.wait({ id: job.id })
        const out = yield* jobs.output({ id: job.id })

        expect(done).toBeDefined()
        expect(done?.status).toBe("completed")
        expect(done?.pid).toBeGreaterThan(0)
        expect(out).toEqual({ text: "ok", cursor: 2, done: true })

        const log = yield* Effect.promise(() => Bun.file(done!.output_path).text())
        const meta = yield* Effect.promise(() => Bun.file(done!.meta_path).json())
        expect(log).toBe("ok")
        expect(meta).toMatchObject({
          id: done!.id,
          status: "completed",
          title: "ok",
          cursor: 2,
        })
      }),
    ),
  )

  it.live("reads output incrementally with a cursor", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const jobs = yield* ShellJob.Service
        const job = yield* jobs.start({
          command: node(
            'process.stdout.write("a"); setTimeout(() => process.stdout.write("b"), 200); setTimeout(() => process.exit(0), 350)',
          ),
          cwd: dir,
        })

        yield* Effect.sleep("100 millis")
        const a = yield* jobs.output({ id: job.id })
        const done = yield* jobs.wait({ id: job.id })
        const b = yield* jobs.output({ id: job.id, cursor: a?.cursor ?? 0 })

        expect(a).toEqual({ text: "a", cursor: 1, done: false })
        expect(done?.status).toBe("completed")
        expect(b).toEqual({ text: "b", cursor: 2, done: true })
      }),
    ),
  )

  it.live("marks non-zero exits as failed", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const jobs = yield* ShellJob.Service
        const job = yield* jobs.start({
          command: node('process.stderr.write("bad"); process.exit(7)'),
          cwd: dir,
        })
        const done = yield* jobs.wait({ id: job.id })
        const out = yield* jobs.output({ id: job.id })

        expect(done).toBeDefined()
        expect(done?.status).toBe("failed")
        expect(done?.exit_code).toBe(7)
        expect(out?.text).toBe("bad")
        expect(out?.done).toBe(true)
      }),
    ),
  )

  it.live("kills a running job and returns final state", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const jobs = yield* ShellJob.Service
        const job = yield* jobs.start({
          command: node("setInterval(() => {}, 1000)"),
          cwd: dir,
        })

        yield* Effect.sleep("50 millis")
        const done = yield* jobs.kill(job.id)

        expect(done).toBeDefined()
        expect(done?.status).toBe("killed")
        expect(done?.exit_code).toBeNull()
      }),
    ),
  )

  it.live("kills running jobs when the instance is disposed", () => {
    if (process.platform === "win32") return Effect.void

    return provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const jobs = yield* ShellJob.Service
        const job = yield* jobs.start({
          command: node("setInterval(() => {}, 1000)"),
          cwd: dir,
        })

        expect(job.pid).toBeGreaterThan(0)
        yield* Effect.sleep("50 millis")
        expect(alive(job.pid!)).toBe(true)

        yield* Effect.promise(() => Instance.dispose())
        yield* Effect.sleep("100 millis")
        expect(alive(job.pid!)).toBe(false)
      }),
    )
  })
})
