export * as ConfigProjectCopy from "./project-copy"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigProjectCopy.Info")({
  strategy: Schema.Literal("git_worktree").pipe(Schema.optional),
  directory: Schema.String.pipe(Schema.optional),
}) {}
