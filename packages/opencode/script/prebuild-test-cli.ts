#!/usr/bin/env bun
// Build a pre-compiled `opencode` binary for subprocess tests, then expose
// it at `dist/test-cli/bin/opencode` for the harness to consume.
//
// Why: each `bun run --conditions=browser src/index.ts <cmd>` spawn pays
// ~15s of JIT + plugin init + DB migration in isolation mode. The
// pre-compiled binary cuts that to ~5s — a 3x improvement on subprocess
// tests that touch the DB (mcp, providers list, etc.).
//
// Usage:
//   bun script/prebuild-test-cli.ts
//   export OPENCODE_TEST_CLI_PATH="$PWD/dist/test-cli/bin/opencode"
//   bun test test/cli/
//
// The harness (see test/lib/cli-process.ts) reads OPENCODE_TEST_CLI_PATH; if
// set, it spawns the binary directly instead of `bun run src/index.ts`. If
// unset, it falls back to dev mode — so this script is strictly opt-in.
//
// Build cost amortizes after ~1 spawn that touches the DB. Recommended for
// CI, manual `bun test test/cli/` runs, and any local iteration where the
// CLI surface itself isn't under change. Skip for normal src/* editing — the
// dev path picks up source changes without rebuild.
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"

const dir = path.resolve(import.meta.dirname, "..")
process.chdir(dir)

const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"
const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "x64"
const targetDir = path.join(dir, "dist", `opencode-${platform}-${arch}`)
const binaryName = process.platform === "win32" ? "opencode.exe" : "opencode"
const builtBinary = path.join(targetDir, "bin", binaryName)

// Stable path the harness reads via OPENCODE_TEST_CLI_PATH. Symlinked so
// the binary itself remains the platform-specific one (build.ts manages it).
const stableBinary = path.join(dir, "dist", "test-cli", "bin", binaryName)

console.log(`Building test CLI binary for ${platform}-${arch}...`)
const start = Date.now()
await $`bun script/build.ts --single --skip-embed-web-ui --skip-install`
const buildMs = Date.now() - start
console.log(`Build complete in ${buildMs}ms: ${builtBinary}`)

await fs.mkdir(path.dirname(stableBinary), { recursive: true })
await fs.rm(stableBinary, { force: true })
await fs.symlink(builtBinary, stableBinary)
console.log(`Symlinked stable path: ${stableBinary}`)
console.log(``)
console.log(`To use in tests:`)
console.log(`  export OPENCODE_TEST_CLI_PATH="${stableBinary}"`)
console.log(`  bun test test/cli/`)
