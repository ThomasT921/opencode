import { describe, expect, test } from "bun:test"
import { ConfigPermission } from "@/config/permission"
import { InvalidConfigError, requireJsonConfig } from "@/util/json"

const decode = (raw: string) => requireJsonConfig(raw, ConfigPermission.Info, "OPENCODE_PERMISSION")

describe("requireJsonConfig with ConfigPermission.Info", () => {
  test("throws InvalidConfigError on malformed JSON", () => {
    let caught: unknown
    try {
      decode("{not json")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvalidConfigError)
    const data = caught as InvalidConfigError
    expect(data.source).toBe("OPENCODE_PERMISSION")
    expect(data.value).toBe("{not json")
    expect(typeof data.reason).toBe("string")
    expect(data.reason.length).toBeGreaterThan(0)
  })

  test("throws InvalidConfigError on shape mismatch", () => {
    let caught: unknown
    try {
      // `banana` is not a valid Action ("ask" | "allow" | "deny")
      decode(`{"bash":"banana"}`)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvalidConfigError)
    const data = caught as InvalidConfigError
    expect(data.source).toBe("OPENCODE_PERMISSION")
    expect(data.value).toBe(`{"bash":"banana"}`)
    expect(data.reason.length).toBeGreaterThan(0)
  })

  test("returns decoded value for Action shorthand", () => {
    expect(decode(`"ask"`)).toEqual({ "*": "ask" })
  })

  test("returns decoded value for object of per-target rules", () => {
    expect(decode(`{"bash":"ask","edit":"allow"}`)).toEqual({
      bash: "ask",
      edit: "allow",
    })
  })

  test("returns decoded value for nested Object rule", () => {
    expect(decode(`{"bash":{"rm *":"deny","ls":"allow"}}`)).toEqual({
      bash: { "rm *": "deny", ls: "allow" },
    })
  })
})
