import { Option, Result, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "config" })

const decodeJsonUnknown = Schema.decodeUnknownResult(Schema.UnknownFromJsonString)

export class InvalidConfigError extends Schema.TaggedErrorClass<InvalidConfigError>()("InvalidConfigError", {
  source: Schema.String,
  value: Schema.String,
  reason: Schema.String,
}) {}

// Decode JSON config at a safety boundary. On malformed JSON or schema
// mismatch, throws `InvalidConfigError`. On success, returns the typed value.
// Use when defaulting silently is dangerous (e.g. permissions).
export function requireJsonConfig<S extends Schema.Decoder<unknown>>(raw: string, schema: S, source: string): S["Type"] {
  const decoded = decode(raw, schema)
  if (Result.isFailure(decoded)) {
    throw new InvalidConfigError({ source, value: raw, reason: decoded.failure })
  }
  return decoded.success
}

// Decode JSON config at a UX-preference boundary. Returns `None` for absent,
// empty, malformed, or schema-mismatched input, logging a warn so the user
// can debug. Use when defaulting silently is benign (e.g. theme, route).
export function tryJsonConfig<S extends Schema.Decoder<unknown>>(
  raw: string | undefined,
  schema: S,
  source: string,
): Option.Option<S["Type"]> {
  if (!raw) return Option.none()
  const decoded = decode(raw, schema)
  if (Result.isFailure(decoded)) {
    log.warn(`ignoring invalid ${source}`, { value: raw, reason: decoded.failure })
    return Option.none()
  }
  return Option.some(decoded.success)
}

function decode<S extends Schema.Decoder<unknown>>(raw: string, schema: S): Result.Result<S["Type"], string> {
  const decodeSchema = Schema.decodeUnknownResult(schema)
  const parsed = decodeJsonUnknown(raw)
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure.toString())
  const decoded = decodeSchema(parsed.success)
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure.toString())
  return Result.succeed(decoded.success)
}
