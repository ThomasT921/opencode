#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { fileURLToPath } from "url"

console.log("=== publishing ===\n")

const pkgjsons = await Array.fromAsync(
  new Bun.Glob("**/package.json").scan({
    absolute: true,
  }),
).then((arr) => arr.filter((x) => !x.includes("node_modules") && !x.includes("dist")))

const extensionToml = fileURLToPath(new URL("../packages/extensions/zed/extension.toml", import.meta.url))

async function prepareReleaseFiles() {
  for (const file of pkgjsons) {
    let pkg = await Bun.file(file).text()
    pkg = pkg.replaceAll(/"version": "[^"]+"/g, `"version": "${Script.version}"`)
    console.log("updated:", file)
    await Bun.file(file).write(pkg)
  }

  let toml = await Bun.file(extensionToml).text()
  toml = toml.replace(/^version = "[^"]+"/m, `version = "${Script.version}"`)
  toml = toml.replaceAll(/releases\/download\/v[^/]+\//g, `releases/download/v${Script.version}/`)
  console.log("updated:", extensionToml)
  await Bun.file(extensionToml).write(toml)

  await $`bun install`
  await $`./packages/sdk/js/script/build.ts`
}

await prepareReleaseFiles()

if (Script.release) {
  if (!Script.preview) {
    await $`git switch --detach`
    await $`git commit -am "release: v${Script.version}"`
    await $`git tag -f v${Script.version}`
    await $`git push origin refs/tags/v${Script.version} --force --no-verify`
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }

  await import(`../packages/desktop/scripts/finalize-latest-json.ts`)
  await import(`../packages/desktop-electron/scripts/finalize-latest-yml.ts`)

  await $`gh release edit v${Script.version} --draft=false --repo ${process.env.GH_REPO}`
}

console.log("\n=== cli ===\n")
await import(`../packages/opencode/script/publish.ts`)

console.log("\n=== sdk ===\n")
await import(`../packages/sdk/js/script/publish.ts`)

console.log("\n=== plugin ===\n")
await import(`../packages/plugin/script/publish.ts`)

if (Script.release && !Script.preview) {
  await $`git fetch origin`
  await $`git checkout -B dev origin/dev`
  await prepareReleaseFiles()
  await $`git commit -am "sync release versions for v${Script.version}"`
  await $`git push origin HEAD:dev --no-verify`
}

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
