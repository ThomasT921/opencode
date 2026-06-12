import { MCP } from "@/mcp"
import { McpContent } from "@/mcp/content"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const ListParameters = Schema.Struct({
  clientName: Schema.optional(Schema.String).annotate({
    description: "Only list resources from this MCP server",
  }),
})

export const ReadParameters = Schema.Struct({
  clientName: Schema.String.annotate({
    description: "The MCP server that provides the resource",
  }),
  uri: Schema.String.annotate({
    description: "The resource URI to read",
  }),
})

export const ListMcpResourcesTool = Tool.define(
  "list_mcp_resources",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service

    return {
      description:
        "List resources exposed by connected MCP servers. Resources are read-only context such as files, schemas, documents, images, and application data. Use read_mcp_resource with the returned clientName and uri to retrieve one.",
      parameters: ListParameters,
      execute: (params: Schema.Schema.Type<typeof ListParameters>) =>
        Effect.gen(function* () {
          const resources = Object.values(yield* mcp.resources())
            .filter((resource) => !params.clientName || resource.client === params.clientName)
            .toSorted(
              (a, b) => a.client.localeCompare(b.client) || a.name.localeCompare(b.name) || a.uri.localeCompare(b.uri),
            )
            .map((resource) => ({
              clientName: resource.client,
              name: resource.name,
              uri: resource.uri,
              ...(resource.description ? { description: resource.description } : {}),
              ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
            }))

          return {
            title: "MCP resources",
            metadata: { count: resources.length },
            output: resources.length ? JSON.stringify({ resources }, null, 2) : "No MCP resources found.",
          }
        }),
    }
  }),
)

export const ReadMcpResourceTool = Tool.define(
  "read_mcp_resource",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service

    return {
      description:
        "Read a resource from a connected MCP server. Use list_mcp_resources to discover resources when needed. Text is returned directly, images are attached for inspection, and other binary data is described by MIME type and size.",
      parameters: ReadParameters,
      execute: (params: Schema.Schema.Type<typeof ReadParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "read_mcp_resource",
            patterns: [`${params.clientName}:${params.uri}`],
            always: [`${params.clientName}:${params.uri}`],
            metadata: { clientName: params.clientName, uri: params.uri },
          })

          const result = yield* mcp.readResource(params.clientName, params.uri)
          if (!result) throw new Error(`Failed to read MCP resource ${params.uri} from ${params.clientName}`)

          const parts = McpContent.toParts(result.contents)
          const output = parts
            .filter((part): part is Extract<McpContent.Part, { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join("\n\n")
          const attachments = parts.filter(
            (part): part is Extract<McpContent.Part, { type: "file" }> => part.type === "file",
          )

          return {
            title: `${params.clientName}: ${params.uri}`,
            metadata: { clientName: params.clientName, uri: params.uri },
            output: output || `Read MCP resource ${params.uri}`,
            ...(attachments.length ? { attachments } : {}),
          }
        }),
    }
  }),
)
