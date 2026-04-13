import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { setTimeout as sleep } from "node:timers/promises"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "../../src/filesystem"
import { LSP } from "../../src/lsp"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(LSP.defaultLayer, CrossSpawnSpawner.defaultLayer, AppFileSystem.defaultLayer))
const server = path.join(import.meta.dir, "../fixture/lsp/fake-lsp-server.js")

describe("LSP cleanup", () => {
  it.live("shuts down clients when their root is deleted", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const mark = path.join(path.dirname(dir), `${path.basename(dir)}.exit`)
        const file = path.join(dir, "test.ts")

        yield* Effect.addFinalizer(() => fs.remove(mark, { force: true }).pipe(Effect.ignore))
        yield* fs.writeWithDirs(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            lsp: {
              typescript: { disabled: true },
              fake: {
                command: [process.execPath, server, mark],
                extensions: [".ts"],
              },
            },
          }),
        )
        yield* fs.writeWithDirs(file, "export {}\n")
        yield* LSP.Service.use((svc) => svc.touchFile(file))
        expect(yield* LSP.Service.use((svc) => svc.status())).toHaveLength(1)

        yield* fs.remove(dir, { recursive: true, force: true })
        expect(yield* LSP.Service.use((svc) => svc.status())).toHaveLength(0)

        for (const _ of Array.from({ length: 20 })) {
          if (yield* fs.exists(mark)) return
          yield* Effect.promise(() => sleep(50))
        }

        throw new Error("fake lsp server did not exit")
      }),
    ),
  )
})
