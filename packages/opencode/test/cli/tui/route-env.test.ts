import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { RouteSchema } from "@/cli/cmd/tui/context/route"
import { tryJsonConfig } from "@/util/json"

const parse = (raw: string | undefined) => tryJsonConfig(raw, RouteSchema, "OPENCODE_ROUTE")

describe("tryJsonConfig with RouteSchema", () => {
  test("returns None for undefined input", () => {
    expect(Option.isNone(parse(undefined))).toBe(true)
  })

  test("returns None for empty string", () => {
    expect(Option.isNone(parse(""))).toBe(true)
  })

  test("returns None for malformed JSON", () => {
    expect(Option.isNone(parse("{not json"))).toBe(true)
  })

  test("returns None when JSON does not match route schema", () => {
    expect(Option.isNone(parse(`{"type":"unknown"}`))).toBe(true)
  })

  test("returns Some for valid home route", () => {
    expect(Option.getOrThrow(parse(`{"type":"home"}`))).toEqual({ type: "home" })
  })

  test("returns Some for valid session route", () => {
    expect(Option.getOrThrow(parse(`{"type":"session","sessionID":"abc123"}`))).toEqual({
      type: "session",
      sessionID: "abc123",
    })
  })

  test("returns Some for valid plugin route", () => {
    expect(Option.getOrThrow(parse(`{"type":"plugin","id":"foo","data":{"x":1}}`))).toEqual({
      type: "plugin",
      id: "foo",
      data: { x: 1 },
    })
  })
})
