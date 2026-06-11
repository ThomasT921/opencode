import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect, Fiber, Layer, Stream } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@opencode-ai/core/git"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectDirectoryTable, ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectCopy } from "@opencode-ai/core/project/copy"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const databaseLayer = Database.layerFromPath(":memory:")
const eventLayer = EventV2.layer.pipe(Layer.provide(databaseLayer))
const pluginLayer = PluginV2.layer.pipe(Layer.provide(eventLayer))
const copyLayer = ProjectCopy.layer.pipe(
  Layer.provide(databaseLayer),
  Layer.provide(eventLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(pluginLayer),
)
const it = testEffect(Layer.mergeAll(copyLayer, databaseLayer, eventLayer, pluginLayer))

function abs(input: string) {
  return AbsolutePath.make(input)
}

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await $`git commit --allow-empty -m root`.cwd(directory).quiet()
}

function setup() {
  return Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    yield* Effect.promise(() => initRepo(root.path))
    const sourceDirectory = abs(yield* Effect.promise(() => fs.realpath(root.path)))
    const projectID = Project.ID.make("copy-project")
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: sourceDirectory, sandboxes: [], time_created: 1, time_updated: 1 })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(ProjectDirectoryTable)
      .values({ project_id: projectID, directory: sourceDirectory, type: "main" })
      .run()
      .pipe(Effect.orDie)
    return { root, sourceDirectory, projectID, db }
  })
}

function stored(projectID: Project.ID) {
  return Database.Service.use(({ db }) =>
    db
      .select({ directory: ProjectDirectoryTable.directory, type: ProjectDirectoryTable.type })
      .from(ProjectDirectoryTable)
      .where(eq(ProjectDirectoryTable.project_id, projectID))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.toSorted((a, b) => a.directory.localeCompare(b.directory))),
      ),
  )
}

describe("ProjectCopy", () => {
  it.live("detects linked git worktrees but not root checkouts", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const target = abs(`${input.root.path}-copy-detected`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(target, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${target} HEAD`.cwd(input.root.path).quiet())

      expect(yield* copy.detect({ directory: input.sourceDirectory })).toBeUndefined()
      expect(yield* copy.detect({ directory: target })).toBe("git_worktree")
    }),
  )

  it.live("creates and removes a git worktree directory", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const events = yield* EventV2.Service
      const temp = yield* Effect.promise(() => fs.realpath(path.dirname(input.root.path)))
      const parent = abs(path.join(temp, path.basename(input.root.path) + "-copy-created"))
      const target = abs(path.join(parent, "copy"))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(parent, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const fiber = yield* events
        .subscribe(ProjectCopy.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      const created = yield* copy.create({
        projectID: input.projectID,
        strategy: "git_worktree",
        sourceDirectory: input.sourceDirectory,
        directory: parent,
        name: "copy",
      })
      expect(created.directory).toBe(target)
      expect(yield* stored(input.projectID)).toEqual(
        [
          { directory: input.sourceDirectory, type: "main" as const },
          { directory: created.directory, type: "git_worktree" as const },
        ].toSorted((a, b) => a.directory.localeCompare(b.directory)),
      )
      expect(Array.from(yield* Fiber.join(fiber))[0]?.data).toEqual({ projectID: input.projectID })

      yield* copy.remove({ projectID: input.projectID, directory: created.directory, force: false })

      expect(yield* stored(input.projectID)).toEqual([{ directory: input.sourceDirectory, type: "main" as const }])
      expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
    }),
  )

  it.live("runs the before create hook before resolving the destination", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const plugins = yield* PluginV2.Service
      const temp = yield* Effect.promise(() => fs.realpath(path.dirname(input.root.path)))
      const parent = abs(path.join(temp, path.basename(input.root.path) + "-copy-hook"))
      const target = abs(path.join(parent, "configured"))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(parent, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* plugins.add({
        id: PluginV2.ID.make("project-copy-test"),
        effect: Effect.succeed({
          "projectCopy.create.before": Effect.fn(function* (event) {
            event.directory = parent
            event.name = "configured"
          }),
        }),
      })

      const created = yield* copy.create({
        projectID: input.projectID,
        strategy: "git_worktree",
        sourceDirectory: input.sourceDirectory,
        directory: abs(path.join(temp, "unused")),
        name: "unused",
      })

      expect(created.directory).toBe(target)
      yield* copy.remove({ projectID: input.projectID, directory: created.directory, force: false })
    }),
  )

  it.live("fails when the before create hook leaves the destination incomplete", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service

      const error = yield* copy
        .create({
          projectID: input.projectID,
          strategy: "git_worktree",
          sourceDirectory: input.sourceDirectory,
        })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(ProjectCopy.CreateUnavailableError)
      expect(yield* stored(input.projectID)).toEqual([{ directory: input.sourceDirectory, type: "main" }])
    }),
  )

  it.live("requires force to remove a dirty git worktree", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const temp = yield* Effect.promise(() => fs.realpath(path.dirname(input.root.path)))
      const parent = abs(path.join(temp, path.basename(input.root.path) + "-copy-dirty"))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(parent, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const created = yield* copy.create({
        projectID: input.projectID,
        strategy: "git_worktree",
        sourceDirectory: input.sourceDirectory,
        directory: parent,
        name: "copy",
      })
      yield* Effect.promise(() => Bun.write(path.join(created.directory, "dirty.txt"), "dirty"))

      const error = yield* copy
        .remove({ projectID: input.projectID, directory: created.directory, force: false })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(Git.WorktreeError)
      if (error instanceof Git.WorktreeError) {
        expect(error.operation).toBe("remove")
        expect(error.forceRequired).toBe(true)
      }
      expect(yield* stored(input.projectID)).toContainEqual({ directory: created.directory, type: "git_worktree" })
      expect(yield* Effect.promise(() => Bun.file(path.join(created.directory, "dirty.txt")).exists())).toBe(true)

      yield* copy.remove({ projectID: input.projectID, directory: created.directory, force: true })
      expect(yield* Effect.promise(() => Bun.file(created.directory).exists())).toBe(false)
    }),
  )

  it.live("does not publish an event when refresh finds no directory changes", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const events = yield* EventV2.Service
      const event = yield* events.subscribe(ProjectCopy.Event.Updated).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
        Effect.flatMap((fiber) =>
          Effect.gen(function* () {
            yield* Effect.yieldNow
            yield* copy.refresh({ projectID: input.projectID })
            return yield* Fiber.join(fiber).pipe(Effect.timeoutOption("50 millis"))
          }),
        ),
      )

      expect(event._tag).toBe("None")
    }),
  )

  it.live("refresh discovers and prunes an externally managed git worktree", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const events = yield* EventV2.Service
      const target = abs(`${input.root.path}-copy-external`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(target, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${target} HEAD`.cwd(input.root.path).quiet())
      const fiber = yield* events
        .subscribe(ProjectCopy.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* copy.refresh({ projectID: input.projectID })

      const discovered = abs(yield* Effect.promise(() => fs.realpath(target)))
      expect(yield* stored(input.projectID)).toEqual(
        [
          { directory: input.sourceDirectory, type: "main" as const },
          { directory: discovered, type: "git_worktree" as const },
        ].toSorted((a, b) => a.directory.localeCompare(b.directory)),
      )
      expect(Array.from(yield* Fiber.join(fiber))[0]?.data).toEqual({ projectID: input.projectID })

      yield* Effect.promise(() => $`git worktree remove --force ${target}`.cwd(input.root.path).quiet())
      yield* copy.refresh({ projectID: input.projectID })
      expect(yield* stored(input.projectID)).toEqual([{ directory: input.sourceDirectory, type: "main" as const }])
    }),
  )

  it.live("refresh ignores stale git worktree registrations", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const stale = abs(`${input.root.path}-copy-stale`)
      const target = abs(`${input.root.path}-copy-after-stale`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(target, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${stale} HEAD`.cwd(input.root.path).quiet())
      yield* Effect.promise(() => fs.rm(stale, { recursive: true, force: true }))
      yield* Effect.promise(() => $`git worktree add --detach ${target} HEAD`.cwd(input.root.path).quiet())

      yield* copy.refresh({ projectID: input.projectID })

      const discovered = abs(yield* Effect.promise(() => fs.realpath(target)))
      expect(yield* stored(input.projectID)).toEqual(
        [
          { directory: input.sourceDirectory, type: "main" as const },
          { directory: discovered, type: "git_worktree" as const },
        ].toSorted((a, b) => a.directory.localeCompare(b.directory)),
      )
    }),
  )

  it.live("refresh with no roots is a no-op", () =>
    Effect.gen(function* () {
      const copy = yield* ProjectCopy.Service

      yield* copy.refresh({ projectID: Project.ID.make("missing-project") })
    }),
  )
})
