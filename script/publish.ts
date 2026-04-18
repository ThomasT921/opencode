#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { fileURLToPath } from "url"

console.log("=== publishing ===\n")

const tag = `v${Script.version}`
const release_commit = `release: ${tag}`

const pkgjsons = await Array.fromAsync(
  new Bun.Glob("**/package.json").scan({
    absolute: true,
  }),
).then((arr) => arr.filter((x) => !x.includes("node_modules") && !x.includes("dist")))

const extensionToml = fileURLToPath(new URL("../packages/extensions/zed/extension.toml", import.meta.url))

async function hasChanges() {
  return (await $`git diff --quiet && git diff --cached --quiet`.nothrow()).exitCode !== 0
}

async function releaseTagReady() {
  const ref = await $`git rev-parse -q --verify refs/tags/${tag}`.nothrow()
  if (ref.exitCode !== 0) return false
  return (await $`git log -1 --format=%s refs/tags/${tag}`.text()).trim() === release_commit
}

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

if (Script.release && !Script.preview) {
  await $`git fetch origin --tags`
  if (await releaseTagReady()) await $`git switch --detach refs/tags/${tag}`
  else await $`git switch --detach`
}

await prepareReleaseFiles()

if (Script.release && !Script.preview && !(await releaseTagReady())) {
  await $`git commit -am ${release_commit}`
  if ((await $`git rev-parse -q --verify refs/tags/${tag}`.nothrow()).exitCode === 0) {
    await $`git tag -f ${tag}`
    await $`git push origin refs/tags/${tag} --force --no-verify`
  } else {
    await $`git tag ${tag}`
    await $`git push origin refs/tags/${tag} --no-verify`
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
}

console.log("\n=== cli ===\n")
await import(`../packages/opencode/script/publish.ts`)

console.log("\n=== sdk ===\n")
await import(`../packages/sdk/js/script/publish.ts`)

console.log("\n=== plugin ===\n")
await import(`../packages/plugin/script/publish.ts`)

if (Script.release) {
  await import(`../packages/desktop/scripts/finalize-latest-json.ts`)
  await import(`../packages/desktop-electron/scripts/finalize-latest-yml.ts`)
}

if (Script.release && !Script.preview) {
  await $`git fetch origin`
  await $`git checkout -B dev origin/dev`
  await prepareReleaseFiles()
  if (await hasChanges()) {
    await $`git commit -am "sync release versions for v${Script.version}"`
    await $`git push origin HEAD:dev --no-verify`
  } else {
    console.log(`dev already synced for ${tag}`)
  }
}

if (Script.release) {
  await $`gh release edit ${tag} --draft=false --repo ${process.env.GH_REPO}`
}

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
