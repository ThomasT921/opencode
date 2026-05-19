import path from "path"
import os from "os"
import { fileURLToPath, pathToFileURL } from "url"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { ConfigMarkdown } from "@/config/markdown"
import { Image } from "@/image/image"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Reference } from "@/reference/reference"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { decodeDataUrl } from "@/util/data-url"
import { NamedError } from "@opencode-ai/core/util/error"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Log from "@opencode-ai/core/util/log"
import { AgentAttachment, FileAttachment, ReferenceAttachment, Source } from "@opencode-ai/core/session-prompt"
import { Cause, Effect, Exit, Option, Schema, Types } from "effect"
import { PartID } from "../schema"
import * as Session from "../session"
import { MessageV2 } from "../message-v2"
import { referencePromptMetadata, referenceTextPart } from "./reference"
import type { PromptInput } from "../prompt"

const log = Log.create({ service: "session.prompt.parts" })
const decodeMessageInfo = Schema.decodeUnknownExit(MessageV2.Info)
const decodeMessagePart = Schema.decodeUnknownExit(MessageV2.Part)

type Services = {
  agents: Agent.Interface
  bus: Bus.Interface
  fsys: AppFileSystem.Interface
  image: Image.Interface
  lsp: LSP.Interface
  mcp: MCP.Interface
  plugin: Plugin.Interface
  provider: Provider.Interface
  references: Reference.Interface
  registry: ToolRegistry.Interface
}

export const resolvePromptParts = Effect.fn("SessionPromptParts.resolvePromptParts")(function* (
  template: string,
  services: Services,
) {
  return yield* resolveTemplateParts(template, services)
})

export const resolveMessageParts = Effect.fn("SessionPromptParts.resolveMessageParts")(function* (
  input: {
    prompt: PromptInput
    info: MessageV2.User
    agent: Agent.Info
  },
  services: Services,
) {
  type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
  const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
    ...part,
    id: part.id ? PartID.make(part.id) : PartID.ascending(),
  })

  const referenceContextFromFilePart = Effect.fnUntraced(function* (
    part: Extract<PromptInput["parts"][number], { type: "file" }>,
    filepath: string,
  ) {
    const name = part.filename?.replace(/#\d+(?:-\d*)?$/, "")
    if (!name) return
    const slash = name.indexOf("/")
    if (slash === -1) return

    const reference = yield* services.references.get(name.slice(0, slash))
    if (!reference || reference.kind === "invalid") return
    if (!AppFileSystem.contains(reference.path, filepath)) return

    const target = path.relative(reference.path, filepath).split(path.sep).join("/")
    if (!target || target.startsWith("../") || target === "..") return

    return referenceTextPart({
      reference,
      source: part.source?.text ?? { value: `@${name}`, start: 0, end: name.length + 1 },
      target,
      targetPath: filepath,
    })
  })

  const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<MessageV2.Part>[]> = Effect.fn(
    "SessionPromptParts.resolveUserPart",
  )(function* (part) {
    if (part.type === "file") {
      if (part.source?.type === "resource") {
        const { clientName, uri } = part.source
        log.info("mcp resource", { clientName, uri, mime: part.mime })
        const pieces: Draft<MessageV2.Part>[] = [
          {
            messageID: input.info.id,
            sessionID: input.prompt.sessionID,
            type: "text",
            synthetic: true,
            text: `Reading MCP resource: ${part.filename} (${uri})`,
          },
        ]
        const exit = yield* services.mcp.readResource(clientName, uri).pipe(Effect.exit)
        if (Exit.isSuccess(exit)) {
          const content = exit.value
          if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
          const items = Array.isArray(content.contents) ? content.contents : [content.contents]
          for (const c of items) {
            if ("text" in c && c.text) {
              pieces.push({
                messageID: input.info.id,
                sessionID: input.prompt.sessionID,
                type: "text",
                synthetic: true,
                text: c.text,
              })
            } else if ("blob" in c && c.blob) {
              const mime = "mimeType" in c ? c.mimeType : part.mime
              pieces.push({
                messageID: input.info.id,
                sessionID: input.prompt.sessionID,
                type: "text",
                synthetic: true,
                text: `[Binary content: ${mime}]`,
              })
            }
          }
          pieces.push({ ...part, messageID: input.info.id, sessionID: input.prompt.sessionID })
        } else {
          const error = Cause.squash(exit.cause)
          log.error("failed to read MCP resource", { error, clientName, uri })
          const message = error instanceof Error ? error.message : String(error)
          pieces.push({
            messageID: input.info.id,
            sessionID: input.prompt.sessionID,
            type: "text",
            synthetic: true,
            text: `Failed to read MCP resource ${part.filename}: ${message}`,
          })
        }
        return pieces
      }
      const url = new URL(part.url)
      switch (url.protocol) {
        case "data:":
          if (part.mime === "text/plain") {
            return [
              {
                messageID: input.info.id,
                sessionID: input.prompt.sessionID,
                type: "text",
                synthetic: true,
                text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
              },
              {
                messageID: input.info.id,
                sessionID: input.prompt.sessionID,
                type: "text",
                synthetic: true,
                text: decodeDataUrl(part.url),
              },
              { ...part, messageID: input.info.id, sessionID: input.prompt.sessionID },
            ]
          }
          break
        case "file:": {
          log.info("file", { mime: part.mime })
          const filepath = fileURLToPath(part.url)
          const referenceContext = yield* referenceContextFromFilePart(part, filepath)
          const mime = (yield* services.fsys.isDir(filepath)) ? "application/x-directory" : part.mime

          const { read } = yield* services.registry.named()
          const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
            const controller = new AbortController()
            return read
              .execute(args, {
                sessionID: input.prompt.sessionID,
                abort: controller.signal,
                agent: input.info.agent,
                messageID: input.info.id,
                extra: { bypassCwdCheck: true, ...extra },
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              })
              .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
          }

          if (mime === "text/plain") {
            let offset: number | undefined
            let limit: number | undefined
            const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
            if (range.start != null) {
              const filePathURI = part.url.split("?")[0]
              let start = parseInt(range.start)
              let end = range.end ? parseInt(range.end) : undefined
              if (start === end) {
                const symbols = yield* services.lsp
                  .documentSymbol(filePathURI)
                  .pipe(Effect.catch(() => Effect.succeed([])))
                for (const symbol of symbols) {
                  let r: LSP.Range | undefined
                  if ("range" in symbol) r = symbol.range
                  else if ("location" in symbol) r = symbol.location.range
                  if (r?.start?.line && r?.start?.line === start) {
                    start = r.start.line
                    end = r?.end?.line ?? start
                    break
                  }
                }
              }
              offset = Math.max(start, 1)
              if (end) limit = end - (offset - 1)
            }
            const args = { filePath: filepath, offset, limit }
            const pieces: Draft<MessageV2.Part>[] = [
              ...(referenceContext
                ? [{ ...referenceContext, messageID: input.info.id, sessionID: input.prompt.sessionID }]
                : []),
              {
                messageID: input.info.id,
                sessionID: input.prompt.sessionID,
                type: "text",
                synthetic: true,
                text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
              },
            ]
            const exit = yield* services.provider.getModel(input.info.model.providerID, input.info.model.modelID).pipe(
              Effect.flatMap((mdl) => execRead(args, { model: mdl })),
              Effect.exit,
            )
            if (Exit.isSuccess(exit)) {
              const result = exit.value
              pieces.push({
                messageID: input.info.id,
                sessionID: input.prompt.sessionID,
                type: "text",
                synthetic: true,
                text: result.output,
              })
              if (result.attachments?.length) {
                pieces.push(
                  ...result.attachments.map((a) => ({
                    ...a,
                    synthetic: true,
                    filename: a.filename ?? part.filename,
                    messageID: input.info.id,
                    sessionID: input.prompt.sessionID,
                  })),
                )
              } else {
                pieces.push({ ...part, mime, messageID: input.info.id, sessionID: input.prompt.sessionID })
              }
            } else {
              const error = Cause.squash(exit.cause)
              log.error("failed to read file", { error })
              const message = error instanceof Error ? error.message : String(error)
              yield* services.bus.publish(Session.Event.Error, {
                sessionID: input.prompt.sessionID,
                error: new NamedError.Unknown({ message }).toObject(),
              })
              pieces.push({
                messageID: input.info.id,
                sessionID: input.prompt.sessionID,
                type: "text",
                synthetic: true,
                text: `Read tool failed to read ${filepath} with the following error: ${message}`,
              })
            }
            return pieces
          }

          if (mime === "application/x-directory") {
            const args = { filePath: filepath }
            const exit = yield* execRead(args).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              const error = Cause.squash(exit.cause)
              log.error("failed to read directory", { error })
              const message = error instanceof Error ? error.message : String(error)
              yield* services.bus.publish(Session.Event.Error, {
                sessionID: input.prompt.sessionID,
                error: new NamedError.Unknown({ message }).toObject(),
              })
              return [
                ...(referenceContext
                  ? [{ ...referenceContext, messageID: input.info.id, sessionID: input.prompt.sessionID }]
                  : []),
                {
                  messageID: input.info.id,
                  sessionID: input.prompt.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                },
              ]
            }
            return [
              ...(referenceContext
                ? [{ ...referenceContext, messageID: input.info.id, sessionID: input.prompt.sessionID }]
                : []),
              {
                messageID: input.info.id,
                sessionID: input.prompt.sessionID,
                type: "text",
                synthetic: true,
                text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
              },
              {
                messageID: input.info.id,
                sessionID: input.prompt.sessionID,
                type: "text",
                synthetic: true,
                text: exit.value.output,
              },
              { ...part, mime, messageID: input.info.id, sessionID: input.prompt.sessionID },
            ]
          }

          return [
            ...(referenceContext
              ? [{ ...referenceContext, messageID: input.info.id, sessionID: input.prompt.sessionID }]
              : []),
            {
              messageID: input.info.id,
              sessionID: input.prompt.sessionID,
              type: "text",
              synthetic: true,
              text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
            },
            {
              id: part.id,
              messageID: input.info.id,
              sessionID: input.prompt.sessionID,
              type: "file",
              url:
                `data:${mime};base64,` +
                Buffer.from(yield* services.fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
              mime,
              filename: part.filename!,
              source: part.source,
            },
          ]
        }
      }
    }

    if (part.type === "agent") {
      const perm = Permission.evaluate("task", part.name, input.agent.permission)
      const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
      return [
        { ...part, messageID: input.info.id, sessionID: input.prompt.sessionID },
        {
          messageID: input.info.id,
          sessionID: input.prompt.sessionID,
          type: "text",
          synthetic: true,
          text:
            " Use the above message and context to generate a prompt and call the task tool with subagent: " +
            part.name +
            hint,
        },
      ]
    }

    return [{ ...part, messageID: input.info.id, sessionID: input.prompt.sessionID }]
  })

  const resolvedParts = yield* Effect.forEach(input.prompt.parts, resolvePart, { concurrency: "unbounded" }).pipe(
    Effect.map((x) => x.flat().map(assign)),
  )

  yield* services.plugin.trigger(
    "chat.message",
    {
      sessionID: input.prompt.sessionID,
      agent: input.prompt.agent,
      model: input.prompt.model,
      messageID: input.prompt.messageID,
      variant: input.prompt.variant,
    },
    { message: input.info, parts: resolvedParts },
  )

  const parts = yield* Effect.forEach(resolvedParts, (part) =>
    part.type === "file" && part.mime.startsWith("image/")
      ? services.image.normalize(part).pipe(
          Effect.catchIf(
            (error) => error instanceof Image.ResizerUnavailableError,
            () => Effect.succeed(part),
          ),
        )
      : Effect.succeed(part),
  )

  validate(input.info, parts)
  return { parts, nextPrompt: nextPrompt(parts) }
})

function resolveTemplateParts(template: string, services: Services) {
  return Effect.gen(function* () {
    const ctx = yield* InstanceState.context
    const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
    const files = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    const mentionSource = (match: RegExpMatchArray) => {
      const start = match.index ?? 0
      return { value: match[0], start, end: start + match[0].length }
    }
    yield* Effect.forEach(
      files,
      Effect.fnUntraced(function* (match) {
        const name = match[1]
        if (!name) return
        if (seen.has(name)) return
        seen.add(name)

        const slash = name.indexOf("/")
        const alias = slash === -1 ? name : name.slice(0, slash)
        const reference = yield* services.references.get(alias)
        if (reference) {
          const source = mentionSource(match)
          if (reference.kind === "invalid") {
            parts.push(
              referenceTextPart({ reference, source, target: slash === -1 ? undefined : name.slice(slash + 1) }),
            )
            return
          }

          yield* services.references.ensure(reference.path)
          if (slash === -1) {
            parts.push(referenceTextPart({ reference, source }))
            return
          }

          const target = name.slice(slash + 1)
          const targetPath = path.resolve(reference.path, target)
          if (!AppFileSystem.contains(reference.path, targetPath)) {
            parts.push(
              referenceTextPart({
                reference,
                source,
                target,
                targetPath,
                problem: `Path escapes configured reference @${alias}: ${target}`,
              }),
            )
            return
          }

          const info = yield* services.fsys.stat(targetPath).pipe(Effect.option)
          if (Option.isNone(info)) {
            parts.push(
              referenceTextPart({
                reference,
                source,
                target,
                targetPath,
                problem: `Path does not exist inside configured reference @${alias}: ${target}`,
              }),
            )
            return
          }

          parts.push({
            type: "file",
            url: pathToFileURL(targetPath).href,
            filename: name,
            mime: info.value.type === "Directory" ? "application/x-directory" : "text/plain",
          })
          return
        }

        const filepath = name.startsWith("~/")
          ? path.join(os.homedir(), name.slice(2))
          : path.resolve(ctx.worktree, name)

        const info = yield* services.fsys.stat(filepath).pipe(Effect.option)
        if (Option.isNone(info)) {
          const found = yield* services.agents.get(name)
          if (found) parts.push({ type: "agent", name: found.name })
          return
        }
        const stat = info.value
        parts.push({
          type: "file",
          url: pathToFileURL(filepath).href,
          filename: name,
          mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
        })
      }),
      { concurrency: "unbounded", discard: true },
    )
    return parts
  })
}

function validate(info: MessageV2.User, parts: MessageV2.Part[]) {
  const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
  if (Exit.isFailure(parsed)) {
    log.error("invalid user message before save", {
      sessionID: info.sessionID,
      messageID: info.id,
      agent: info.agent,
      model: info.model,
      cause: Cause.pretty(parsed.cause),
    })
  }
  parts.forEach((part, index) => {
    const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(p)) return
    log.error("invalid user part before save", {
      sessionID: info.sessionID,
      messageID: info.id,
      partID: part.id,
      partType: part.type,
      index,
      cause: Cause.pretty(p.cause),
      part,
    })
  })
}

function nextPrompt(parts: MessageV2.Part[]) {
  return parts.reduce(
    (result, part) => {
      if (part.type === "text") {
        if (part.synthetic) result.synthetic.push(part.text)
        else result.text.push(part.text)
        const reference = referencePromptMetadata(part.metadata?.reference)
        if (reference) {
          result.references.push(
            new ReferenceAttachment({
              name: reference.name,
              kind: reference.kind,
              uri: reference.path ? pathToFileURL(reference.path).href : undefined,
              repository: reference.repository,
              branch: reference.branch,
              target: reference.target,
              targetUri: reference.targetPath ? pathToFileURL(reference.targetPath).href : undefined,
              problem: reference.problem,
              source: new Source({
                start: reference.source.start,
                end: reference.source.end,
                text: reference.source.value,
              }),
            }),
          )
        }
      }
      if (part.type === "file") {
        result.files.push(
          new FileAttachment({
            uri: part.url,
            mime: part.mime,
            name: part.filename,
            source: part.source
              ? new Source({
                  start: part.source.text.start,
                  end: part.source.text.end,
                  text: part.source.text.value,
                })
              : undefined,
          }),
        )
      }
      if (part.type === "agent") {
        result.agents.push(
          new AgentAttachment({
            name: part.name,
            source: part.source
              ? new Source({
                  start: part.source.start,
                  end: part.source.end,
                  text: part.source.value,
                })
              : undefined,
          }),
        )
      }
      return result
    },
    {
      text: [] as string[],
      files: [] as FileAttachment[],
      agents: [] as AgentAttachment[],
      references: [] as ReferenceAttachment[],
      synthetic: [] as string[],
    },
  )
}

export * as SessionPromptParts from "./parts"
