export * as ConfigReference from "./reference"

import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import path from "path"

const Git = Schema.Struct({
  repository: Schema.String.annotate({
    description: "Git repository URL, host/path reference, or GitHub owner/repo shorthand",
  }),
  branch: Schema.optional(Schema.String).annotate({
    description: "Branch or ref Scout should clone and inspect",
  }),
})

const Local = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path, ~/ path, or workspace-relative path to a local reference directory",
  }),
})

export const Entry = Schema.Union([Schema.String, Git, Local]).annotate({ identifier: "ReferenceConfigEntry" })

export const Info = Schema.Record(Schema.String, Entry)
  .annotate({ identifier: "ReferenceConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export type Entry = Schema.Schema.Type<typeof Entry>
export type Resolved = { kind: "git"; repository: string; branch?: string } | { kind: "local"; path: string }

type Context = {
  directory: string
  worktree: string
}

function referencePath(value: string, ctx: Context) {
  if (value.startsWith("~/")) return path.join(Global.Path.home, value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(ctx.worktree === "/" ? ctx.directory : ctx.worktree, value)
}

export function resolve(reference: Entry, ctx: Context): Resolved {
  if (typeof reference === "string") {
    if (reference.startsWith(".") || reference.startsWith("/") || reference.startsWith("~")) {
      return { kind: "local", path: referencePath(reference, ctx) }
    }
    return { kind: "git", repository: reference }
  }
  if ("path" in reference) return { kind: "local", path: referencePath(reference.path, ctx) }
  return { kind: "git", repository: reference.repository, branch: reference.branch }
}

export function prompt(name: string, reference: Resolved) {
  if (reference.kind === "local") {
    return [
      `@${name} is a configured Scout reference, not a separate subagent or skill.`,
      `Local directory: ${reference.path}`,
      `In the task prompt, tell Scout to inspect this directory as the primary reference source. Prefer repo_overview with path ${JSON.stringify(reference.path)} before broader searches. Do not edit files in the reference.`,
    ].join("\n")
  }

  return [
    `@${name} is a configured Scout reference, not a separate subagent or skill.`,
    `Repository: ${reference.repository}`,
    ...(reference.branch ? [`Branch/ref: ${reference.branch}`] : []),
    "In the task prompt, tell Scout to clone or refresh this repository with repo_clone, then inspect the cached repository as the primary reference source. Do not edit files in the reference.",
  ].join("\n")
}
