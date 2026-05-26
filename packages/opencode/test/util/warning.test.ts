import { expect, test } from "bun:test"
import { Process } from "@/util/process"

test("suppresses metadata lookup warnings without hiding other warnings", async () => {
  const out = await Process.run([
    process.execPath,
    "-e",
    'await import("./src/util/warning.ts"); process.emitWarning("metadata", "MetadataLookupWarning"); process.emitWarning("visible", "VisibleWarning")',
  ])

  expect(out.stderr.toString()).not.toContain("MetadataLookupWarning")
  expect(out.stderr.toString()).toContain("VisibleWarning: visible")
})
