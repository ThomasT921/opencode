import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigAttachments } from "@opencode-ai/core/config/attachments"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ReadTool } from "@opencode-ai/core/tool/read"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { RelativePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const assertions: PermissionV2.AssertInput[] = []
const reads: FileSystem.ReadInput[] = []
const samples: number[] = []
const textPageInputs: FileSystem.TextPageInput[] = []
const pages: FileSystem.ListTarget[] = []
const pageInputs: Pick<FileSystem.ListPageInput, "offset" | "limit">[] = []
let resolvedInput: FileSystem.ReadInput | undefined
let resolveFailure: unknown
let listResolveFailure: unknown = new Error("not a directory")
let listReal = "/project/src"
let size = 5
let real = "/project/README.md"
let afterApproval = () => {}
let readFailure: unknown
let readContent: FileSystem.Content = new FileSystem.TextContent({
  type: "text",
  content: "hello",
  mime: "text/plain",
})
let sample = new TextEncoder().encode("hello")
let configEntries: Config.Entry[] = []
const resourceReads: ToolOutputStore.ReadInput[] = []
const filesystem = Layer.succeed(
  FileSystem.Service,
  FileSystem.Service.of({
    read: () => Effect.die("unused"),
    resolveReadPath: (input) =>
      resolveFailure === undefined
        ? Effect.succeed({
            type: "file" as const,
            target: new FileSystem.ReadTarget({
              real,
              resource: input.reference === undefined ? "README.md" : `${input.reference}:README.md`,
              size,
              dev: 1,
            }),
          })
        : listResolveFailure === undefined
          ? Effect.succeed({
              type: "directory" as const,
              target: new FileSystem.ListTarget({
                absolute: `/project/${input.path ?? "."}`,
                real: listReal,
                directory: "/project",
                root: "/project",
                resource: input.path ?? ".",
              }),
            })
          : Effect.die(resolveFailure),
    resolveRead: (input) =>
      Effect.sync(() => {
        resolvedInput = input
      }).pipe(
        Effect.andThen(
          resolveFailure === undefined
            ? Effect.succeed(
                new FileSystem.ReadTarget({
                  real,
                  resource: input.reference === undefined ? "README.md" : `${input.reference}:README.md`,
                  size,
                  dev: 1,
                }),
              )
            : Effect.die(resolveFailure),
        ),
      ),
    readResolved: () =>
      readFailure === undefined
        ? Effect.sync(() => {
            reads.push({ path: RelativePath.make("README.md") })
            return readContent
          })
        : Effect.die(readFailure),
    readSampleResolved: (_target, maximumBytes) =>
      Effect.sync(() => {
        samples.push(maximumBytes)
        return sample.slice(0, maximumBytes)
      }),
    readTextPageResolved: (_target, page = {}) =>
      readFailure === undefined
        ? Effect.sync(() => {
            textPageInputs.push(page)
            return new FileSystem.TextPage({
              type: "text-page",
              content: "hello",
              mime: "text/plain",
              offset: page.offset ?? 1,
              truncated: true,
              next: (page.offset ?? 1) + 1,
            })
          })
        : Effect.die(readFailure),
    resolveRoot: () => Effect.die("unused"),
    revalidateRoot: Effect.succeed,
    list: () => Effect.die("unused"),
    resolveList: (input = {}) =>
      listResolveFailure === undefined
        ? Effect.succeed(
            new FileSystem.ListTarget({
              absolute: `/project/${input.path ?? "."}`,
              real: listReal,
              directory: "/project",
              root: "/project",
              resource: input.path ?? ".",
            }),
          )
        : Effect.die(listResolveFailure),
    listResolved: () => Effect.die("unused"),
    listPage: () => Effect.die("unused"),
    listPageResolved: (target, page = {}) =>
      Effect.sync(() => {
        pages.push(target)
        pageInputs.push(page)
        return new FileSystem.ListPage({ entries: [], truncated: false })
      }),
    find: () => Effect.die("unused"),
    grep: () => Effect.die("unused"),
    isIgnored: () => false,
  }),
)
let allow = true
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => {
        assertions.push(input)
        if (allow) afterApproval()
      }).pipe(Effect.andThen(allow ? Effect.void : Effect.fail(new PermissionV2.DeniedError({ rules: [] })))),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const resources = Layer.succeed(
  ToolOutputStore.Service,
  ToolOutputStore.Service.of({
    limits: () => Effect.die("unused"),
    write: () => Effect.die("unused"),
    truncate: () => Effect.die("unused"),
    cleanup: () => Effect.die("unused"),
    read: (input) =>
      Effect.sync(() => {
        resourceReads.push(input)
        return new ToolOutputStore.Page({
          resource: new ToolOutputStore.Resource({ uri: input.uri, mime: "text/plain", size: 5 }),
          content: "hello",
          offset: input.offset ?? 0,
          truncated: false,
        })
      }),
  }),
)
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(configEntries) }))
const read = ReadTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(filesystem),
  Layer.provide(permission),
  Layer.provide(resources),
  Layer.provide(config),
)
const it = testEffect(Layer.mergeAll(registry, filesystem, permission, resources, config, read))
const sessionID = SessionV2.ID.make("ses_read_tool_test")

describe("ReadTool", () => {
  it.effect("registers, authorizes, and reads through the location filesystem", () =>
    Effect.gen(function* () {
      assertions.length = 0
      reads.length = 0
      allow = true
      resolveFailure = undefined
      listResolveFailure = new Error("not a directory")
      size = 5
      real = "/project/README.md"
      afterApproval = () => {}
      readFailure = undefined
      readContent = new FileSystem.TextContent({ type: "text", content: "hello", mime: "text/plain" })
      sample = new TextEncoder().encode("hello")
      configEntries = []
      resolvedInput = undefined
      const registry = yield* ToolRegistry.Service

      expect(yield* registry.definitions()).toMatchObject([{ name: "read" }])
      expect(
        yield* registry.execute({
          sessionID,
          call: { type: "tool-call", id: "call-read", name: "read", input: { path: "README.md" } },
        }),
      ).toEqual({ type: "json", value: { type: "text", content: "hello", mime: "text/plain" } })
      expect(assertions).toMatchObject([{ sessionID, action: "read", resources: ["README.md"], save: ["*"] }])
      expect(reads).toEqual([{ path: RelativePath.make("README.md") }])
    }),
  )

  it.effect("does not read when permission is denied", () =>
    Effect.gen(function* () {
      assertions.length = 0
      reads.length = 0
      allow = false
      resolveFailure = undefined
      listResolveFailure = new Error("not a directory")
      size = 5
      real = "/project/README.md"
      afterApproval = () => {}
      resolvedInput = undefined
      const registry = yield* ToolRegistry.Service

      expect(
        yield* registry.execute({
          sessionID,
          call: { type: "tool-call", id: "call-read", name: "read", input: { path: "README.md" } },
        }),
      ).toEqual({ type: "error", value: "Unable to read README.md" })
      expect(reads).toEqual([])
    }),
  )

  it.effect("reads an opaque managed resource without treating it as a path", () =>
    Effect.gen(function* () {
      resourceReads.length = 0
      assertions.length = 0
      const registry = yield* ToolRegistry.Service

      expect(
        yield* registry.execute({
          sessionID,
          call: {
            type: "tool-call",
            id: "call-read-resource",
            name: "read",
            input: { resource: "tool-output://opaque", offset: 2, limit: 10 },
          },
        }),
      ).toEqual({
        type: "json",
        value: {
          resource: { uri: "tool-output://opaque", mime: "text/plain", size: 5 },
          content: "hello",
          offset: 2,
          truncated: false,
        },
      })
      expect(resourceReads).toEqual([{ sessionID, uri: "tool-output://opaque", offset: 2, limit: 10 }])
      expect(assertions).toEqual([])
    }),
  )

  it.effect("returns supported images as model-native media", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 4 }, () => 255)), 1, 1)
      const content = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      allow = true
      resolveFailure = undefined
      listResolveFailure = new Error("not a directory")
      size = 4
      real = "/project/image.png"
      afterApproval = () => {}
      readFailure = undefined
      readContent = new FileSystem.BinaryContent({
        type: "binary",
        content,
        encoding: "base64",
        mime: "image/png",
      })
      sample = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const registry = yield* ToolRegistry.Service

      expect(
        yield* registry.execute({
          sessionID,
          call: { type: "tool-call", id: "call-image", name: "read", input: { path: "image.png" } },
        }),
      ).toEqual({
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          { type: "media", mediaType: "image/png", data: content, filename: "image.png" },
        ],
      })
      expect(samples.at(-1)).toBe(FileSystem.READ_SAMPLE_BYTES)
    }),
  )

  it.effect("applies configured image dimension limits before returning media", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 16 * 4 }, () => 255)), 16, 1)
      allow = true
      resolveFailure = undefined
      listResolveFailure = new Error("not a directory")
      size = source.get_bytes().length
      real = "/project/wide.png"
      afterApproval = () => {}
      readFailure = undefined
      readContent = new FileSystem.BinaryContent({
        type: "binary",
        content: Buffer.from(source.get_bytes()).toString("base64"),
        encoding: "base64",
        mime: "image/png",
      })
      source.free()
      sample = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      configEntries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            attachments: new ConfigAttachments.Info({
              image: new ConfigAttachments.Image({ max_width: 4, max_height: 4 }),
            }),
          }),
        }),
      ]
      const registry = yield* ToolRegistry.Service
      const result = yield* registry.execute({
        sessionID,
        call: { type: "tool-call", id: "call-resize-image", name: "read", input: { path: "wide.png" } },
      })
      expect(result.type).toBe("content")
      if (result.type !== "content") return
      const media = result.value[1]
      expect(media?.type).toBe("media")
      if (media?.type !== "media") return
      const resized = photon.PhotonImage.new_from_byteslice(Buffer.from(media.data, "base64"))
      expect(resized.get_width()).toBeLessThanOrEqual(4)
      expect(resized.get_height()).toBeLessThanOrEqual(4)
      resized.free()
    }),
  )

  it.effect("lists a bounded directory page through read", () =>
    Effect.gen(function* () {
      assertions.length = 0
      pages.length = 0
      pageInputs.length = 0
      allow = true
      resolveFailure = new Error("Path is not a file")
      listResolveFailure = undefined
      listReal = "/project/src"
      afterApproval = () => {}
      const registry = yield* ToolRegistry.Service

      expect(
        yield* registry.execute({
          sessionID,
          call: {
            type: "tool-call",
            id: "call-read-directory",
            name: "read",
            input: { path: "src", offset: 2, limit: 10 },
          },
        }),
      ).toEqual({ type: "json", value: { entries: [], truncated: false } })
      expect(assertions).toMatchObject([{ sessionID, action: "read", resources: ["src"], save: ["*"] }])
      expect(pageInputs).toEqual([{ offset: 2, limit: 10 }])
    }),
  )

  it.effect("does not list a directory when permission is denied", () =>
    Effect.gen(function* () {
      pages.length = 0
      allow = false
      resolveFailure = new Error("Path is not a file")
      listResolveFailure = undefined
      listReal = "/project/src"
      afterApproval = () => {}
      const registry = yield* ToolRegistry.Service

      expect(
        yield* registry.execute({
          sessionID,
          call: { type: "tool-call", id: "call-read-directory-denied", name: "read", input: { path: "src" } },
        }),
      ).toEqual({ type: "error", value: "Unable to read src" })
      expect(pages).toEqual([])
    }),
  )

  it.effect("does not list when the directory changes after permission approval", () =>
    Effect.gen(function* () {
      pages.length = 0
      allow = true
      resolveFailure = new Error("Path is not a file")
      listResolveFailure = undefined
      listReal = "/project/src"
      afterApproval = () => {
        listReal = "/outside/src"
      }
      const registry = yield* ToolRegistry.Service

      expect(
        yield* registry.execute({
          sessionID,
          call: { type: "tool-call", id: "call-read-directory-swapped", name: "read", input: { path: "src" } },
        }),
      ).toEqual({ type: "error", value: "Unable to read src" })
      expect(pages).toEqual([])
    }),
  )

  it.effect("authorizes project references with their canonical identity", () =>
    Effect.gen(function* () {
      assertions.length = 0
      reads.length = 0
      allow = true
      resolveFailure = undefined
      listResolveFailure = new Error("not a directory")
      size = 5
      real = "/project/README.md"
      afterApproval = () => {}
      resolvedInput = undefined
      const registry = yield* ToolRegistry.Service

      yield* registry.execute({
        sessionID,
        call: { type: "tool-call", id: "call-read", name: "read", input: { path: "README.md", reference: "docs" } },
      })

      expect(assertions).toMatchObject([{ resources: ["docs:README.md"] }])
    }),
  )

  it.effect("settles missing files as typed tool errors", () =>
    Effect.gen(function* () {
      allow = true
      reads.length = 0
      real = "/project/README.md"
      afterApproval = () => {}
      const registry = yield* ToolRegistry.Service

      resolveFailure = new Error("missing")
      listResolveFailure = new Error("missing")
      expect(
        yield* registry.execute({
          sessionID,
          call: { type: "tool-call", id: "call-missing", name: "read", input: { path: "missing.txt" } },
        }),
      ).toEqual({ type: "error", value: "Unable to read missing.txt" })

      expect(reads).toEqual([])
    }),
  )

  it.effect("reads large UTF-8 text files as bounded pages with continuation", () =>
    Effect.gen(function* () {
      textPageInputs.length = 0
      allow = true
      resolveFailure = undefined
      listResolveFailure = new Error("not a directory")
      size = FileSystem.MAX_READ_BYTES + 1
      real = "/project/large.txt"
      afterApproval = () => {}
      readFailure = undefined
      readContent = new FileSystem.TextContent({ type: "text", content: "hello", mime: "text/plain" })
      sample = new TextEncoder().encode("hello")
      configEntries = []
      const registry = yield* ToolRegistry.Service

      expect(
        yield* registry.execute({
          sessionID,
          call: {
            type: "tool-call",
            id: "call-large",
            name: "read",
            input: { path: "large.txt", offset: 2, limit: 1 },
          },
        }),
      ).toEqual({
        type: "json",
        value: { type: "text-page", content: "hello", mime: "text/plain", offset: 2, truncated: true, next: 3 },
      })
      expect(textPageInputs).toEqual([{ offset: 2, limit: 1 }])
    }),
  )

  it.effect("reports the binary file that cannot be paged", () =>
    Effect.gen(function* () {
      allow = true
      resolveFailure = undefined
      listResolveFailure = new Error("not a directory")
      size = FileSystem.MAX_READ_BYTES + 1
      real = "/project/archive.zip"
      afterApproval = () => {}
      readFailure = new FileSystem.BinaryFileError("archive.zip")
      const registry = yield* ToolRegistry.Service

      expect(
        yield* registry.execute({
          sessionID,
          call: { type: "tool-call", id: "call-binary", name: "read", input: { path: "archive.zip" } },
        }),
      ).toEqual({ type: "error", value: "Cannot read binary file: archive.zip" })
    }),
  )

  it.effect("does not read when the file changes after permission approval", () =>
    Effect.gen(function* () {
      assertions.length = 0
      reads.length = 0
      allow = true
      resolveFailure = undefined
      listResolveFailure = new Error("not a directory")
      size = 5
      real = "/project/README.md"
      afterApproval = () => {
        real = "/outside/README.md"
      }
      const registry = yield* ToolRegistry.Service
      expect(
        yield* registry.execute({
          sessionID,
          call: { type: "tool-call", id: "call-swapped", name: "read", input: { path: "README.md" } },
        }),
      ).toEqual({ type: "error", value: "Unable to read README.md" })
      expect(reads).toEqual([])
    }),
  )
})
