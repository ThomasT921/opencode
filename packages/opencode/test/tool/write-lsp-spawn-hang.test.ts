import { afterEach, beforeAll, afterAll, describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import path from "path"
import fs from "fs/promises"
import { Npm } from "@opencode-ai/shared/npm"
import { Config } from "../../src/config"
import { WriteTool } from "../../src/tool/write"
import { Instance } from "../../src/project/instance"
import * as LSP from "../../src/lsp/lsp"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { FileTime } from "../../src/file/time"
import { Bus } from "../../src/bus"
import { Format } from "../../src/format"
import { Truncate } from "../../src/tool"
import { Tool } from "../../src/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Reproduces the "forever" branch of issue #22872 — in a sandboxed
// container with no network and no cached pyright binary, Pyright.spawn
// calls `Npm.Service.which("pyright")` which internally uses
// `arborist.reify()` with no timeout. If the npm registry is
// unreachable, that promise never resolves and the write tool blocks
// indefinitely.
//
// Here we mock Npm.Service so `which("pyright")` returns Effect.never,
// simulating the unbounded network block. The write tool must still
// return quickly for the fix to be correct — shortening the 45s
// LSPClient.create initialize timeout would NOT help this case, so
// the fix must bound the touchFile enrichment tail itself.

const ctx = {
  sessionID: SessionID.make("ses_test-write-lsp-spawn-hang"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

// Ensure pyright-langserver isn't picked up from the user's real PATH
// during the test — we want the spawn to fall through to Npm.which.
let savedPath: string | undefined
beforeAll(() => {
  savedPath = process.env.PATH
  process.env.PATH = ""
})
afterAll(() => {
  process.env.PATH = savedPath
})

afterEach(async () => {
  await Instance.disposeAll()
})

const hangingNpm = Layer.mock(Npm.Service)({
  add: () => Effect.never,
  install: () => Effect.never,
  outdated: () => Effect.succeed(false),
  which: () => Effect.never as unknown as Effect.Effect<Option.Option<string>>,
})

// Build the LSP layer with the hanging Npm mock in place of the real one.
// LSP.defaultLayer pre-provides the real EffectNpm.defaultLayer which would
// shadow any outer provide, so we wire the mock directly into LSP.layer.
const lspWithHangingNpm = LSP.layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(hangingNpm))

const it = testEffect(
  Layer.mergeAll(
    lspWithHangingNpm,
    AppFileSystem.defaultLayer,
    FileTime.defaultLayer,
    Bus.layer,
    Format.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const init = Effect.fn("WriteLspSpawnHangTest.init")(function* () {
  const info = yield* WriteTool
  return yield* info.init()
})

const run = Effect.fn("WriteLspSpawnHangTest.run")(function* (
  args: Tool.InferParameters<typeof WriteTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

describe("tool.write (LSP spawn hang — issue #22872 forever branch)", () => {
  it.live(
    "completes promptly when Npm.Service.which hangs forever during LSP spawn",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "hello.py")
          const started = Date.now()
          const result = yield* run({ filePath: filepath, content: "print('hi')" })
          const elapsed = Date.now() - started

          // File is on disk even though LSP spawn is wedged.
          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(content).toBe("print('hi')")
          expect(result.output).toContain("Wrote file successfully")

          // The LSP spawn path is blocked forever (Npm.Service.which
          // returns Effect.never). The write tool's 5s enrichment
          // timeout must win, so the tool returns within roughly 5s.
          expect(elapsed).toBeLessThan(7_000)
        }),
      ),
    15_000,
  )
})
