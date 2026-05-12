export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import { Context, Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { ConfigParse } from "./parse"

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}

export interface Interface {
  readonly projectFiles: (
    name: string,
    directory: string,
    worktree?: string,
  ) => Effect.Effect<string[], AppFileSystem.Error>
  readonly directories: (directory: string, worktree?: string) => Effect.Effect<string[], AppFileSystem.Error>
  readonly readFile: (filepath: string) => Effect.Effect<string | undefined, AppFileSystem.Error>
  readonly parseText: (text: string, filepath: string) => Effect.Effect<unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ConfigPaths") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const afs = yield* AppFileSystem.Service

    const projectFiles = Effect.fn("ConfigPaths.projectFiles")(function* (
      name: string,
      directory: string,
      worktree?: string,
    ) {
      return (yield* afs.up({
        targets: [`${name}.jsonc`, `${name}.json`],
        start: directory,
        stop: worktree,
      })).toReversed()
    })

    const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
      return unique([
        Global.Path.config,
        ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
          ? yield* afs.up({
              targets: [".opencode"],
              start: directory,
              stop: worktree,
            })
          : []),
        ...(yield* afs.up({
          targets: [".opencode"],
          start: Global.Path.home,
          stop: Global.Path.home,
        })),
        ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
      ])
    })

    const readFile = Effect.fn("ConfigPaths.readFile")(function* (filepath: string) {
      return yield* afs.readFileStringSafe(filepath)
    })

    const parseText = Effect.fn("ConfigPaths.parseText")(function* (text: string, filepath: string) {
      return ConfigParse.jsonc(text, filepath)
    })

    return Service.of({ projectFiles, directories, readFile, parseText })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))
