import { SessionV1 } from "@opencode-ai/core/v1/session"
import { isImageAttachment } from "@/util/media"

type ResourceContent = {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export type Part = SessionV1.TextPartInput | SessionV1.FilePartInput

export function toParts(contents: readonly ResourceContent[]): Part[] {
  return contents.flatMap((content) => {
    if (content.text) return [{ type: "text", text: content.text }]
    if (!content.blob) return []

    const mime = content.mimeType?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream"
    if (isImageAttachment(mime)) {
      return [
        {
          type: "file",
          mime,
          filename: content.uri,
          url: `data:${mime};base64,${content.blob}`,
        },
      ]
    }

    return [
      {
        type: "text",
        text: `[Binary resource: ${mime}, ${Buffer.from(content.blob, "base64").byteLength} bytes]`,
      },
    ]
  })
}

export * as McpContent from "./content"
