import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { InvalidConfigError, requireJsonConfig, tryJsonConfig } from "@/util/json"

const PointSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
})

describe("requireJsonConfig", () => {
  test("returns decoded value on success", () => {
    expect(requireJsonConfig(`{"x":1,"y":2}`, PointSchema, "TEST")).toEqual({ x: 1, y: 2 })
  })

  test("throws InvalidConfigError on malformed JSON", () => {
    let caught: unknown
    try {
      requireJsonConfig("not json", PointSchema, "TEST")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvalidConfigError)
    const err = caught as InvalidConfigError
    expect(err.source).toBe("TEST")
    expect(err.value).toBe("not json")
    expect(err.reason.length).toBeGreaterThan(0)
  })

  test("throws InvalidConfigError on schema mismatch", () => {
    let caught: unknown
    try {
      requireJsonConfig(`{"x":"oops"}`, PointSchema, "TEST")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvalidConfigError)
    const err = caught as InvalidConfigError
    expect(err.source).toBe("TEST")
    expect(err.value).toBe(`{"x":"oops"}`)
    expect(err.reason.length).toBeGreaterThan(0)
  })

  test("InvalidConfigError carries _tag for downstream matching", () => {
    let caught: unknown
    try {
      requireJsonConfig("not json", PointSchema, "TEST")
    } catch (error) {
      caught = error
    }
    expect((caught as { _tag: string })._tag).toBe("InvalidConfigError")
  })
})

describe("tryJsonConfig", () => {
  test("returns Some on success", () => {
    const decoded = tryJsonConfig(`{"x":1,"y":2}`, PointSchema, "TEST")
    expect(Option.isSome(decoded)).toBe(true)
    expect(Option.getOrThrow(decoded)).toEqual({ x: 1, y: 2 })
  })

  test("returns None for undefined input", () => {
    expect(Option.isNone(tryJsonConfig(undefined, PointSchema, "TEST"))).toBe(true)
  })

  test("returns None for empty string", () => {
    expect(Option.isNone(tryJsonConfig("", PointSchema, "TEST"))).toBe(true)
  })

  test("returns None for malformed JSON", () => {
    expect(Option.isNone(tryJsonConfig("not json", PointSchema, "TEST"))).toBe(true)
  })

  test("returns None on schema mismatch", () => {
    expect(Option.isNone(tryJsonConfig(`{"x":"oops"}`, PointSchema, "TEST"))).toBe(true)
  })
})
