export * as ReadTool from "./read"

import { Tool, ToolFailure } from "@opencode-ai/llm"
import { Cause, Effect, Layer, Schema } from "effect"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Config } from "../config"
import { FileSystem } from "../filesystem"
import { NonNegativeInt, PositiveInt } from "../schema"
import { PermissionV2 } from "../permission"
import { ToolOutputStore } from "../tool-output-store"
import { FSUtil } from "../fs-util"
import { ToolRegistry } from "./registry"

export const name = "read"
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_WIDTH = 2_000
const MAX_IMAGE_HEIGHT = 2_000
const JPEG_QUALITIES = [80, 85, 70, 55, 40]
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)
const imageMime = (bytes: Uint8Array, fallback: string) => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]))
    return "image/webp"
  return fallback
}

class ImageSizeError extends Error {}
const LocationInput = Schema.Struct({
  ...FileSystem.ReadInput.fields,
  offset: FileSystem.ListPageInput.fields.offset.annotate({
    description: "The 1-based directory entry or text line offset to start reading from",
  }),
  limit: FileSystem.ListPageInput.fields.limit.annotate({
    description: "The maximum number of directory entries or text lines to read",
  }),
})
const ResourceInput = Schema.Struct({
  resource: Schema.String,
  offset: NonNegativeInt.pipe(Schema.optional),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(ToolOutputStore.MAX_READ_BYTES)).pipe(Schema.optional),
})
const Input = Schema.Union([LocationInput, ResourceInput])
const Success = Schema.Union([FileSystem.Content, FileSystem.TextPage, FileSystem.ListPage, ToolOutputStore.Page])

const definition = Tool.make({
  description:
    "Read a text file or supported image, page through a large UTF-8 text file by line offset, list a directory page relative to the current location, or page through a managed tool-output resource by opaque URI.",
  parameters: Input,
  success: Success,
  toModelOutput: ({ parameters, output }) => {
    if (!("type" in output) || output.type !== "binary" || !SUPPORTED_IMAGE_MIMES.has(output.mime)) return []
    return [
      { type: "text", text: "Image read successfully" },
      {
        type: "file",
        source: { type: "data", data: output.content },
        mime: output.mime,
        ...(parameters && "path" in parameters ? { name: parameters.path } : {}),
      },
    ]
  },
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const filesystem = yield* FileSystem.Service
    const resources = yield* ToolOutputStore.Service
    const config = yield* Config.Service
    const loadPhoton = yield* Effect.cached(
      Effect.sync(() => {
        const photonWasm = fileURLToPath(import.meta.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm"))
        ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
          path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
      }).pipe(Effect.andThen(() => Effect.promise(() => import("@silvia-odwyer/photon-node")))),
    )

    yield* registry.contribute((editor) =>
      editor.set(name, {
        tool: definition,
        execute: ({ parameters, sessionID, assertPermission }) => {
          const input = parameters
          return Effect.gen(function* () {
            if ("resource" in input)
              return yield* resources.read({ sessionID, uri: input.resource, offset: input.offset, limit: input.limit })
            const resolved = yield* filesystem.resolveReadPath(input)
            if (resolved.type === "directory") {
              const { offset, limit } = input
              const target = resolved.target
              yield* assertPermission({ action: name, resources: [target.resource], save: ["*"] })
              const final = yield* filesystem.resolveReadPath(input)
              if (
                final.type !== "directory" ||
                final.target.resource !== target.resource ||
                final.target.real !== target.real
              )
                return yield* Effect.die(new Error("Directory changed after permission approval"))
              return yield* filesystem.listPageResolved(final.target, { offset, limit })
            }
            const target = resolved.target
            yield* assertPermission({
              action: name,
              resources: [target.resource],
              save: ["*"],
            })
            const final = yield* filesystem.resolveReadPath(input)
            if (final.type !== "file" || final.target.resource !== target.resource || final.target.real !== target.real)
              return yield* Effect.die(new Error("File changed after permission approval"))
            const mime = imageMime(
              yield* filesystem.readSampleResolved(final.target, FileSystem.READ_SAMPLE_BYTES),
              FSUtil.mimeType(final.target.real),
            )
            if (!SUPPORTED_IMAGE_MIMES.has(mime)) {
              if (
                final.target.size > FileSystem.MAX_READ_BYTES ||
                input.offset !== undefined ||
                input.limit !== undefined
              )
                return yield* filesystem.readTextPageResolved(final.target, { offset: input.offset, limit: input.limit })
              return yield* filesystem.readResolved(final.target, FileSystem.MAX_READ_BYTES)
            }
            const content = yield* filesystem.readResolved(final.target)
            if (content.type !== "binary") return content
            const image = Object.assign(
              {},
              ...(yield* config.entries()).flatMap((entry) =>
                entry.type === "document" && entry.info.attachments?.image ? [entry.info.attachments.image] : [],
              ),
            )
            const limits = {
              autoResize: image.auto_resize ?? true,
              maxWidth: image.max_width ?? MAX_IMAGE_WIDTH,
              maxHeight: image.max_height ?? MAX_IMAGE_HEIGHT,
              maxBase64Bytes: image.max_base64_bytes ?? MAX_IMAGE_BASE64_BYTES,
            }
            const photon = yield* loadPhoton
            const decoded = yield* Effect.sync(() =>
              photon.PhotonImage.new_from_byteslice(Buffer.from(content.content, "base64")),
            )
            try {
              const width = decoded.get_width()
              const height = decoded.get_height()
              if (
                width <= limits.maxWidth &&
                height <= limits.maxHeight &&
                Buffer.byteLength(content.content, "utf8") <= limits.maxBase64Bytes
              )
                return new FileSystem.BinaryContent({ ...content, mime })
              if (!limits.autoResize)
                return yield* Effect.die(
                  new ImageSizeError(
                    `Image ${width}x${height} with base64 size ${Buffer.byteLength(content.content, "utf8")} exceeds configured limits ${limits.maxWidth}x${limits.maxHeight}/${limits.maxBase64Bytes} bytes`,
                  ),
                )
              const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height)
              const sizes = Array.from({ length: 32 }).reduce<Array<{ width: number; height: number }>>((acc) => {
                const previous = acc.at(-1) ?? {
                  width: Math.max(1, Math.round(width * scale)),
                  height: Math.max(1, Math.round(height * scale)),
                }
                const next =
                  acc.length === 0
                    ? previous
                    : {
                        width: previous.width === 1 ? 1 : Math.max(1, Math.floor(previous.width * 0.75)),
                        height: previous.height === 1 ? 1 : Math.max(1, Math.floor(previous.height * 0.75)),
                      }
                return acc.some((item) => item.width === next.width && item.height === next.height) ? acc : [...acc, next]
              }, [])
              for (const size of sizes) {
                const resized = photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
                const candidate = [
                  { content: Buffer.from(resized.get_bytes()).toString("base64"), mime: "image/png" },
                  ...JPEG_QUALITIES.map((quality) => ({
                    content: Buffer.from(resized.get_bytes_jpeg(quality)).toString("base64"),
                    mime: "image/jpeg",
                  })),
                ].find((item) => Buffer.byteLength(item.content, "utf8") <= limits.maxBase64Bytes)
                resized.free()
                if (candidate)
                  return new FileSystem.BinaryContent({
                    type: "binary",
                    content: candidate.content,
                    encoding: "base64",
                    mime: candidate.mime,
                  })
              }
              return yield* Effect.die(
                new ImageSizeError(
                  `Image ${width}x${height} with base64 size ${Buffer.byteLength(content.content, "utf8")} exceeds configured limits and could not be resized below ${limits.maxWidth}x${limits.maxHeight}/${limits.maxBase64Bytes} bytes`,
                ),
              )
            } finally {
              decoded.free()
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const error = Cause.squash(cause)
                const message =
                  error instanceof FileSystem.BinaryFileError ||
                  error instanceof FileSystem.ReadLimitError ||
                  error instanceof ImageSizeError
                    ? error.message
                    : `Unable to read ${"resource" in input ? input.resource : input.path}`
                return yield* new ToolFailure({ message, error })
              }),
            ),
          )
        },
      }),
    )
  }),
)
export const locationLayer = layer.pipe(
  Layer.provideMerge(ToolRegistry.defaultLayer),
  Layer.provideMerge(FileSystem.locationLayer),
  Layer.provideMerge(PermissionV2.locationLayer),
  Layer.provideMerge(ToolOutputStore.defaultLayer),
)
