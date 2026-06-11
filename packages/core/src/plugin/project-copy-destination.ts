export * as ProjectCopyDestinationPlugin from "./project-copy-destination"

import path from "path"
import { Effect } from "effect"
import { Config } from "../config"
import { Global } from "../global"
import { Location } from "../location"
import { PluginV2 } from "../plugin"
import { ProjectCopy } from "../project/copy"
import { AbsolutePath } from "../schema"
import { FSUtil } from "../fs-util"
import { Slug } from "../util/slug"

export const Plugin = PluginV2.define({
  id: PluginV2.ID.make("project-copy-destination"),
  effect: Effect.gen(function* () {
    const config = Config.latest(yield* (yield* Config.Service).entries(), "projectCopy")
    const global = yield* Global.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service

    return {
      "projectCopy.create.before": Effect.fn(function* (event) {
        event.strategy = event.strategy ?? config?.strategy
        event.name ??= Slug.create()
        event.name = sanitize(event.name) || Slug.create()

        if (!event.directory) {
          let dest = path.join(location.project.directory, ".worktrees", event.name)
          if (config?.directory) {
            dest = config.directory
              .replaceAll("{project.name}", path.basename(location.project.directory))
              .replaceAll("{project.directory}", location.project.directory)
              .replaceAll("{project.id}", location.project.id)
              .replaceAll("{name}", event.name)
          }

          dest =
            dest === "~"
              ? global.home
              : dest.startsWith("~/")
                ? path.join(global.home, dest.slice(2))
                : path.resolve(location.project.directory, dest)
          event.directory = AbsolutePath.make(path.dirname(dest))
          event.name = path.basename(dest)
        }

        const name = event.name
        let suffix = 1
        let destination = AbsolutePath.make(path.join(event.directory, name))
        while (yield* fs.existsSafe(destination)) {
          suffix++
          if (suffix > 10) {
            event.error = new ProjectCopy.DestinationExistsError({ directory: destination })
            return
          }
          event.name = `${name}-${suffix}`
          destination = AbsolutePath.make(path.join(event.directory, event.name))
        }
      }),
    }
  }),
})

function sanitize(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}
