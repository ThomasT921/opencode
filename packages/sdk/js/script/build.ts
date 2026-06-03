#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"
import { generateFiles, parseSpec } from "@workos/oagen"
import { effectEmitter } from "./effect-emitter.js"

const opencode = path.resolve(dir, "../../opencode")

await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

const openapi = await Bun.file("./openapi.json").json()
const effect = generateFiles(await parseSpec("./openapi.json"), effectEmitter, {
  namespace: "Opencode",
  outputDir: "./src/v2/gen",
  emitterOptions: {
    serverSentEvents: serverSentEvents(openapi),
  },
})
for (const file of effect.files) {
  await Bun.write(path.join("./src/v2/gen", file.path), file.content)
}

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`

function serverSentEvents(spec: unknown) {
  if (!spec || typeof spec !== "object" || !("paths" in spec) || !spec.paths || typeof spec.paths !== "object")
    return []

  return Object.entries(spec.paths).flatMap(([route, value]) => {
    if (!value || typeof value !== "object") return []

    return Object.entries(value).flatMap(([method, operation]) => {
      if (!operation || typeof operation !== "object" || !("responses" in operation)) return []
      if (!hasEventStream(operation.responses)) return []
      return [`${method.toUpperCase()} ${route}`]
    })
  })
}

function hasEventStream(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  if ("text/event-stream" in value) return true
  return Object.values(value).some(hasEventStream)
}
