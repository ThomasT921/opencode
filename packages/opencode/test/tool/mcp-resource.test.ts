import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { MessageID, SessionID } from "@/session/schema"
import { ListMcpResourcesTool, ReadMcpResourceTool } from "@/tool/mcp-resource"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const mcp = Layer.mock(MCP.Service, {
  resources: () =>
    Effect.succeed({
      "zeta:guide": {
        client: "zeta",
        name: "guide",
        uri: "fixture://guide",
        description: "Guide",
        mimeType: "text/plain",
      },
      "alpha:picture": {
        client: "alpha",
        name: "picture",
        uri: "fixture://picture",
        mimeType: "image/png",
      },
    }),
  readResource: (clientName, uri) =>
    Effect.succeed(
      clientName === "alpha" && uri === "fixture://picture"
        ? {
            contents: [
              { uri, mimeType: "text/plain", text: "caption" },
              { uri, mimeType: "image/png", blob: "aGVsbG8=" },
            ],
          }
        : undefined,
    ),
})

const it = testEffect(Layer.mergeAll(mcp, Truncate.defaultLayer, Agent.defaultLayer))

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

describe("tool.mcp-resource", () => {
  it.instance("lists resources in a deterministic order", () =>
    Effect.gen(function* () {
      const info = yield* ListMcpResourcesTool
      const tool = yield* info.init()
      const result = yield* tool.execute({}, { ...baseCtx, ask: () => Effect.void })

      expect(JSON.parse(result.output)).toEqual({
        resources: [
          { clientName: "alpha", name: "picture", uri: "fixture://picture", mimeType: "image/png" },
          {
            clientName: "zeta",
            name: "guide",
            uri: "fixture://guide",
            description: "Guide",
            mimeType: "text/plain",
          },
        ],
      })
    }),
  )

  it.instance("returns text and image content from a resource", () =>
    Effect.gen(function* () {
      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const info = yield* ReadMcpResourceTool
      const tool = yield* info.init()
      const result = yield* tool.execute(
        { clientName: "alpha", uri: "fixture://picture" },
        {
          ...baseCtx,
          ask: (request) =>
            Effect.sync(() => {
              requests.push(request)
            }),
        },
      )

      expect(result.output).toBe("caption")
      expect(result.attachments).toEqual([
        {
          type: "file",
          mime: "image/png",
          filename: "fixture://picture",
          url: "data:image/png;base64,aGVsbG8=",
        },
      ])
      expect(requests[0]).toMatchObject({
        permission: "read_mcp_resource",
        patterns: ["alpha:fixture://picture"],
        always: ["alpha:fixture://picture"],
      })
    }),
  )
})
