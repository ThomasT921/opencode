import path from "path"
import * as NodeFS from "fs/promises"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@/filesystem"
import { Shell } from "@/shell/shell"
import { Effect, Layer, Scope, Deferred, Stream, Context, Exit, Schema, Struct } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"

import { JobID } from "./schema"

const PS = new Set(["powershell", "pwsh"])

export namespace ShellJob {
  export const Status = Schema.Literals(["running", "completed", "failed", "killed", "timed_out"])
  export type Status = Schema.Schema.Type<typeof Status>

  export class Info extends Schema.Class<Info>("ShellJob.Info")({
    id: JobID,
    command: Schema.String,
    cwd: Schema.String,
    shell: Schema.String,
    title: Schema.optional(Schema.String),
    status: Status,
    pid: Schema.optional(Schema.Number),
    started_at: Schema.Number,
    ended_at: Schema.optional(Schema.Number),
    exit_code: Schema.optional(Schema.NullOr(Schema.Number)),
    output_path: Schema.String,
    meta_path: Schema.String,
    cursor: Schema.Number,
  }) {}

  export class Output extends Schema.Class<Output>("ShellJob.Output")({
    text: Schema.String,
    cursor: Schema.Number,
    done: Schema.Boolean,
  }) {}

  export class StartInput extends Schema.Class<StartInput>("ShellJob.StartInput")({
    command: Schema.String,
    cwd: Schema.optional(Schema.String),
    shell: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    timeout: Schema.optional(Schema.Number),
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }) {}

  export class WaitInput extends Schema.Class<WaitInput>("ShellJob.WaitInput")({
    id: JobID,
    timeout: Schema.optional(Schema.Number),
  }) {}

  export class OutputInput extends Schema.Class<OutputInput>("ShellJob.OutputInput")({
    id: JobID,
    cursor: Schema.optional(Schema.Number),
  }) {}

  type Active = {
    info: Struct.Mutable<Info>
    next: Status | undefined
    done: Deferred.Deferred<Info>
    handle: ChildProcessHandle | undefined
  }

  type State = {
    dir: string
    root: string
    jobs: Map<JobID, Active>
    scope: Scope.Scope
  }

  export interface Interface {
    readonly list: () => Effect.Effect<Info[]>
    readonly get: (id: JobID) => Effect.Effect<Info | undefined>
    readonly start: (input: StartInput) => Effect.Effect<Info>
    readonly output: (input: OutputInput) => Effect.Effect<Output | undefined>
    readonly wait: (input: WaitInput) => Effect.Effect<Info | undefined>
    readonly kill: (id: JobID) => Effect.Effect<Info | undefined>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/ShellJob") {}

  function spawn(shell: string, name: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
    if (process.platform === "win32" && PS.has(name)) {
      return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
        cwd,
        env,
        stdin: "ignore",
        detached: false,
      })
    }

    return ChildProcess.make(command, [], {
      shell,
      cwd,
      env,
      stdin: "ignore",
      detached: process.platform !== "win32",
    })
  }

  const snap = (job: Active) =>
    new Info({
      ...job.info,
      id: String(job.info.id),
    })

  export const layer: Layer.Layer<Service, never, AppFileSystem.Service | ChildProcessSpawner> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const spawner = yield* ChildProcessSpawner

      const append = Effect.fn("ShellJob.append")(function* (job: Active, chunk: string) {
        yield* Effect.tryPromise({
          try: () => NodeFS.appendFile(job.info.output_path, chunk, "utf8"),
          catch: () => new Error("Failed to append shell job output"),
        }).pipe(Effect.orDie)
      })

      const write = Effect.fn("ShellJob.write")(function* (job: Active) {
        yield* fs.writeJson(job.info.meta_path, job.info).pipe(Effect.orDie)
      })

      const end = Effect.fn("ShellJob.end")(function* (job: Active, status: Status, code?: number | null) {
        if (job.info.status !== "running") return snap(job)
        job.info.status = status
        job.info.ended_at = Date.now()
        job.info.exit_code = code
        job.handle = undefined
        job.next = undefined
        yield* write(job)
        const info = snap(job)
        yield* Deferred.succeed(job.done, info).pipe(Effect.ignore)
        return info
      })

      const watch = Effect.fn("ShellJob.watch")(function* (job: Active, timeout?: number) {
        const handle = job.handle
        if (!handle) return snap(job)

        if (timeout) {
          yield* Effect.sleep(`${timeout} millis`).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                if (job.info.status !== "running") return
                job.next = "timed_out"
                yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore)
              }),
            ),
            Effect.forkScoped,
          )
        }

        yield* Effect.forkScoped(
          Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
            Effect.gen(function* () {
              job.info.cursor += chunk.length
              yield* append(job, chunk)
            }),
          ),
        )

        const exit = yield* Effect.exit(handle.exitCode)
        if (Exit.isSuccess(exit)) {
          const code = Number(exit.value)
          return yield* end(job, code === 0 ? "completed" : "failed", code)
        }

        return yield* end(job, job.next ?? "killed", null)
      })

      const state = yield* InstanceState.make<State>(
        Effect.fn("ShellJob.state")(function* (ctx) {
          const dir = ctx.project.vcs ? ctx.worktree : ctx.directory
          const root = path.join(dir, ".opencode", "jobs")
          const state: State = {
            dir: ctx.directory,
            root,
            jobs: new Map(),
            scope: yield* Scope.Scope,
          }

          yield* fs.ensureDir(root).pipe(Effect.orDie)
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              state.jobs.clear()
            }),
          )

          return state
        }),
      )

      const list: Interface["list"] = Effect.fn("ShellJob.list")(function* () {
        const s = yield* InstanceState.get(state)
        return Array.from(s.jobs.values())
          .map(snap)
          .toSorted((a, b) => a.started_at - b.started_at)
      })

      const get: Interface["get"] = Effect.fn("ShellJob.get")(function* (id: JobID) {
        const s = yield* InstanceState.get(state)
        const job = s.jobs.get(id)
        if (!job) return
        return snap(job)
      })

      const start: Interface["start"] = Effect.fn("ShellJob.start")(function* (input: StartInput) {
        const s = yield* InstanceState.get(state)
        const id = JobID.ascending()
        const dir = path.join(s.root, String(id))
        const cwd = input.cwd ?? s.dir
        const shell = input.shell ?? Shell.acceptable()
        const name = Shell.name(shell)
        const handle = yield* Scope.provide(s.scope)(
          spawner.spawn(
            spawn(shell, name, input.command, cwd, {
              ...process.env,
              ...input.env,
            }),
          ),
        ).pipe(Effect.orDie)

        const job: Active = {
          info: {
            id,
            command: input.command,
            cwd,
            shell,
            title: input.title,
            status: "running",
            pid: Number(handle.pid),
            started_at: Date.now(),
            output_path: path.join(dir, "output.log"),
            meta_path: path.join(dir, "meta.json"),
            cursor: 0,
          } satisfies Struct.Mutable<Info>,
          next: undefined,
          done: yield* Deferred.make<Info>(),
          handle,
        }

        s.jobs.set(id, job)
        yield* fs.writeWithDirs(job.info.output_path, "").pipe(Effect.orDie)
        yield* write(job)
        yield* Effect.sync(() => {
          Effect.runFork(Scope.provide(s.scope)(watch(job, input.timeout)))
        })
        return snap(job)
      })

      const output: Interface["output"] = Effect.fn("ShellJob.output")(function* (input: OutputInput) {
        const s = yield* InstanceState.get(state)
        const job = s.jobs.get(input.id)
        if (!job) return
        const cursor = input.cursor ?? 0
        const text = yield* fs.readFileString(job.info.output_path).pipe(Effect.catch(() => Effect.succeed("")))
        return new Output({
          text: cursor >= text.length ? "" : text.slice(cursor),
          cursor: text.length,
          done: job.info.status !== "running",
        })
      })

      const wait: Interface["wait"] = Effect.fn("ShellJob.wait")(function* (input: WaitInput) {
        const s = yield* InstanceState.get(state)
        const job = s.jobs.get(input.id)
        if (!job) return
        if (job.info.status !== "running") return snap(job)
        if (!input.timeout) return yield* Deferred.await(job.done)
        return yield* Effect.raceAll([
          Deferred.await(job.done),
          Effect.sleep(`${input.timeout} millis`).pipe(Effect.as(snap(job))),
        ])
      })

      const kill: Interface["kill"] = Effect.fn("ShellJob.kill")(function* (id: JobID) {
        const s = yield* InstanceState.get(state)
        const job = s.jobs.get(id)
        if (!job) return
        if (job.info.status !== "running") return snap(job)
        if (!job.handle) return snap(job)
        if (!job.next) job.next = "killed"
        yield* job.handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore)
        return yield* Deferred.await(job.done)
      })

      return Service.of({
        list,
        get,
        start,
        output,
        wait,
        kill,
      })
    }),
  )
}
