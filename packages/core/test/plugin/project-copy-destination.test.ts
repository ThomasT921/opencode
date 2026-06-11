import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigProjectCopy } from "@opencode-ai/core/config/project-copy"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { ProjectCopyDestinationPlugin } from "@opencode-ai/core/plugin/project-copy-destination"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { it } from "../lib/effect"

const projectID = Project.ID.make("project-id")
const root = "/projects/example"
const databaseNode = LayerNode.make(Database.layerFromPath(":memory:"), [])
const configNode = makeConfig(new Config.Info({}))
const globalNode = LayerNode.make(
  Layer.succeed(Global.Service, Global.Service.of(Global.make({ data: "/data", home: "/home/test" }))),
  [],
)
const locationNode = LayerNode.make(
  Layer.succeed(
    Location.Service,
    Location.Service.of({
      directory: AbsolutePath.make(root),
      project: { id: projectID, directory: AbsolutePath.make(root) },
    }),
  ),
  [],
)
const installNode = LayerNode.make(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const config = yield* Config.Service
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const location = yield* Location.Service
      yield* plugin.add({
        id: ProjectCopyDestinationPlugin.Plugin.id,
        effect: ProjectCopyDestinationPlugin.Plugin.effect.pipe(
          Effect.provideService(Config.Service, config),
          Effect.provideService(FSUtil.Service, fs),
          Effect.provideService(Global.Service, global),
          Effect.provideService(Location.Service, location),
        ),
      })
    }),
  ),
  [PluginV2.node, configNode, globalNode, locationNode, FSUtil.node],
)
const graph = LayerNode.group([PluginV2.node, installNode])

function makeConfig(info: Config.Info) {
  return LayerNode.make(
    Layer.succeed(
      Config.Service,
      Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info,
            }),
          ]),
      }),
    ),
    [],
  )
}

function providePlugin(info = new Config.Info({})) {
  return Effect.provide(
    LayerNode.buildLayer(graph, {
      replacements: [
        LayerNode.replace(Database.node, databaseNode),
        LayerNode.replace(configNode, makeConfig(info)),
      ],
    }),
  )
}

function trigger(input: { name?: string; directory?: AbsolutePath }) {
  return PluginV2.Service.use((plugin) =>
    plugin.trigger(
      "projectCopy.create.before",
      { projectID, sourceDirectory: AbsolutePath.make("/projects/example") },
      { strategy: "git_worktree", ...input },
    ),
  )
}

describe("ProjectCopyDestinationPlugin", () => {
  it.effect(
    "expands project variables and sanitizes the copy name",
    () =>
      Effect.gen(function* () {
        const result = yield* trigger({ name: "Fix / Auth: Please" })

        expect(result.directory).toBe(AbsolutePath.make("/projects/example/copies"))
        expect(result.name).toBe("example-project-id-fix-auth-please")
      }).pipe(
        providePlugin(
          new Config.Info({
            projectCopy: new ConfigProjectCopy.Info({
              strategy: "git_worktree",
              directory: "{project.directory}/copies/{project.name}-{project.id}-{name}",
            }),
          }),
        ),
      ),
  )

  it.effect("preserves an explicit directory and sanitizes the name", () =>
    Effect.gen(function* () {
      const result = yield* trigger({ directory: AbsolutePath.make("/tmp/copies"), name: "A/B" })

      expect(result.directory).toBe(AbsolutePath.make("/tmp/copies"))
      expect(result.name).toBe("a-b")
    }).pipe(providePlugin()),
  )

  it.live("adds a suffix when destinations already exist", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => fs.mkdir(path.join(directory.path, "copy")))
      yield* Effect.promise(() => fs.mkdir(path.join(directory.path, "copy-2")))

      const result = yield* trigger({ directory: AbsolutePath.make(directory.path), name: "copy" })

      expect(result.name).toBe("copy-3")
      expect(result.error).toBeUndefined()
    }).pipe(providePlugin()),
  )

  it.live("returns an error after ten destination conflicts", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 10 }, (_, index) =>
            fs.mkdir(path.join(directory.path, index === 0 ? "copy" : `copy-${index + 1}`)),
          ),
        ),
      )

      const result = yield* trigger({ directory: AbsolutePath.make(directory.path), name: "copy" })

      expect(result.error).toBeInstanceOf(Error)
      expect(result.error?.directory).toBe(AbsolutePath.make(path.join(directory.path, "copy-10")))
    }).pipe(providePlugin()),
  )
})
