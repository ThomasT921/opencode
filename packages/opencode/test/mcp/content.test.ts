import { describe, expect, test } from "bun:test"
import { McpContent } from "@/mcp/content"

describe("mcp.content", () => {
  test("converts text, images, and other binary resources", () => {
    expect(
      McpContent.toParts([
        { uri: "fixture://guide", mimeType: "text/plain", text: "hello" },
        { uri: "fixture://picture", mimeType: "IMAGE/PNG; charset=binary", blob: "aGVsbG8=" },
        { uri: "fixture://archive", mimeType: "application/zip", blob: "aGVsbG8=" },
      ]),
    ).toEqual([
      { type: "text", text: "hello" },
      {
        type: "file",
        mime: "image/png",
        filename: "fixture://picture",
        url: "data:image/png;base64,aGVsbG8=",
      },
      { type: "text", text: "[Binary resource: application/zip, 5 bytes]" },
    ])
  })

  test("does not treat SVG resources as model images", () => {
    expect(McpContent.toParts([{ uri: "fixture://vector", mimeType: "image/svg+xml", blob: "PHN2Zy8+" }])).toEqual([
      { type: "text", text: "[Binary resource: image/svg+xml, 6 bytes]" },
    ])
  })
})
