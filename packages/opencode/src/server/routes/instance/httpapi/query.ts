import { Schema } from "effect"

export const WorkspaceRoutingQueryFields = {
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
}

export function withWorkspaceRouting<T extends Schema.Struct.Fields>(fields: T) {
  return Schema.Struct({
    ...WorkspaceRoutingQueryFields,
    ...fields,
  })
}
