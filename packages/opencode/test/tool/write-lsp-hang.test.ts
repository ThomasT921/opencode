import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import { WriteTool } from "../../src/tool/write"
import { Instance } from "../../src/project/instance"
import { LSP } from "../../src/lsp"
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

// Reproduces issue #22872 — the write tool hangs when an LSP server for the
// file's extension spawns successfully but never answers the `initialize`
// request. The fake LSP here swallows every message, mimicking pyright in
// the reporter's Docker container. If the write tool correctly bounds the
// diagnostic-enrichment tail (lsp.touchFile + lsp.diagnostics) the whole
// call should finish quickly, well before the 45s LSPClient.create timeout.

const HANGING_SERVER = path.resolve(__dirname, "..", "fixture", "lsp", "hanging-lsp-server.js")

const ctx = {
  sessionID: SessionID.make("ses_test-write-lsp-hang"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    FileTime.defaultLayer,
    Bus.layer,
    Format.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const init = Effect.fn("WriteLspHangTest.init")(function* () {
  const info = yield* WriteTool
  return yield* info.init()
})

const run = Effect.fn("WriteLspHangTest.run")(function* (
  args: Tool.InferParameters<typeof WriteTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

describe("tool.write (LSP hang — issue #22872)", () => {
  it.live(
    "completes promptly when the LSP server for this extension never finishes initialize",
    () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const filepath = path.join(dir, "hello.hang")
            const started = Date.now()
            const result = yield* run({ filePath: filepath, content: "print('hi')" })
            const elapsed = Date.now() - started

            // On disk content is correct.
            const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
            expect(content).toBe("print('hi')")
            expect(result.output).toContain("Wrote file successfully")

            // Regression guard: touchFile/diagnostics must not block the
            // tool on the LSP initialize timeout. The write tool wraps
            // its enrichment tail in a 5s Effect.timeout, so the tool
            // must return within roughly 5s regardless of LSP state.
            expect(elapsed).toBeLessThan(7_000)
          }),
        {
          config: {
            lsp: {
              "hang-ls": {
                command: ["node", HANGING_SERVER],
                extensions: [".hang"],
              },
            },
          },
        },
      ),
    60_000,
  )
})
