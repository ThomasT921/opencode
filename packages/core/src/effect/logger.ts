import { appendFileSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Layer, Logger, References, Schema } from "effect"
import * as Global from "../global"
import { ensureProcessMetadata } from "../util/opencode-process"

type Fields = Record<string, unknown>

export const Level = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})
export type Level = Schema.Schema.Type<typeof Level>

const levelPriority: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}

const normalizeKey = (key: string) => (key === "sessionID" ? "session.id" : key)

const clean = (input?: object): Fields =>
  Object.fromEntries(
    Object.entries(input ?? {})
      .filter((entry) => entry[1] !== undefined && entry[1] !== null)
      .map(([key, value]) => [normalizeKey(key), value]),
  )

export function file() {
  if (disabled(process.env.OPENCODE_LOG_FILE)) return ""
  return process.env.OPENCODE_LOG_FILE || path.join(Global.Path.log, "log.jsonl")
}

function shouldLog(input: Level): boolean {
  return levelPriority[input] >= levelPriority[parseLevel(process.env.OPENCODE_LOG_LEVEL) ?? "INFO"]
}

function write(input: { json: string; pretty: string }) {
  const target = file()
  if (target) {
    try {
      appendFileSync(target, input.json)
    } catch {}
  }
  if (truthy(process.env.OPENCODE_PRINT_LOGS)) process.stderr.write(input.pretty)
}

function build(inputLevel: Level, ts: Date, message: unknown, fields: Fields): { json: string; pretty: string } {
  const metadata = ensureProcessMetadata("main")
  const service = typeof fields.service === "string" ? fields.service : undefined
  if (service) delete fields.service
  const text = stringifyMessage(message)
  const record = {
    ts: ts.toISOString(),
    level: inputLevel,
    message: text,
    run_id: metadata.runID,
    process_role: metadata.processRole,
    pid: process.pid,
    service,
    fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, normalize(value)])),
  }
  const prefix = Object.entries({ service, ...record.fields })
    .filter((entry) => entry[1] !== undefined && entry[1] !== null)
    .map(([key, value]) => `${key}=${typeof value === "object" ? safeStringify(value) : value}`)
    .join(" ")
  return {
    json: safeStringify(record) + "\n",
    pretty: [inputLevel.padEnd(5), ts.toISOString().split(".")[0], prefix, text].filter(Boolean).join(" ") + "\n",
  }
}

const logger = Logger.make((opts) => {
  const extra = clean(opts.fiber.getRef(References.CurrentLogAnnotations))
  const now = opts.date.getTime()
  for (const [key, start] of opts.fiber.getRef(References.CurrentLogSpans)) {
    extra[`logSpan.${key}`] = `${now - start}ms`
  }
  if (opts.cause.reasons.length > 0) {
    extra.cause = Cause.pretty(opts.cause)
  }

  switch (opts.logLevel) {
    case "Trace":
    case "Debug":
      if (shouldLog("DEBUG")) write(build("DEBUG", opts.date, opts.message, extra))
      return
    case "Warn":
      if (shouldLog("WARN")) write(build("WARN", opts.date, opts.message, extra))
      return
    case "Error":
    case "Fatal":
      if (shouldLog("ERROR")) write(build("ERROR", opts.date, opts.message, extra))
      return
    default:
      if (shouldLog("INFO")) write(build("INFO", opts.date, opts.message, extra))
  }
})

type LoggerInput = Logger.Logger<unknown, unknown> | Effect.Effect<Logger.Logger<unknown, unknown>, unknown, unknown>

const makeLayer = <const Loggers extends ReadonlyArray<LoggerInput>>(loggers: Loggers) =>
  Logger.layer(loggers, { mergeWithExisting: false }).pipe(
    Layer.tap(() =>
      Effect.promise(async () => {
        const target = file()
        if (target) await fs.mkdir(path.dirname(target), { recursive: true })
      }),
    ),
  )

export const layer = makeLayer([logger])

export const layerWith = <const Loggers extends ReadonlyArray<LoggerInput>>(loggers: Loggers) =>
  makeLayer([logger, ...loggers] as const)

function truthy(value: string | undefined) {
  return value?.toLowerCase() === "1" || value?.toLowerCase() === "true"
}

function disabled(value: string | undefined) {
  const lower = value?.toLowerCase()
  return lower === "0" || lower === "false" || lower === "off"
}

function parseLevel(value: string | undefined): Level | undefined {
  if (value === "DEBUG" || value === "INFO" || value === "WARN" || value === "ERROR") return value
  return undefined
}

function formatError(error: Error, depth = 0): string {
  const result = error.message
  return error.cause instanceof Error && depth < 10
    ? result + " Caused by: " + formatError(error.cause, depth + 1)
    : result
}

function stringifyMessage(message: unknown): string {
  if (message instanceof Error) return formatError(message)
  if (message === undefined) return ""
  if (typeof message === "string") return message
  if (Array.isArray(message)) return message.map((item) => stringifyMessage(item)).join(" ")
  if (typeof message === "object") return safeStringify(message)
  return String(message)
}

function normalize(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: formatError(value),
      stack: value.stack,
    }
  }
  if (typeof value === "bigint") return value.toString()
  return value
}

function safeStringify(value: unknown) {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_, item) => {
    if (typeof item === "bigint") return item.toString()
    if (item instanceof Error) return normalize(item)
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return "[Circular]"
      seen.add(item)
    }
    return item
  })
}
