import { expect, test } from "bun:test"
import {
  absoluteTreePath,
  advanceTreePreload,
  nextSuggestionIndex,
  nextTreeScrollTop,
  pickerTreeEntries,
  pickerSearchEntries,
  pickerFileSearchQuery,
  pickerMode,
  preloadTreeDirectories,
  selectedTreePath,
  treeEntries,
} from "./directory-tree"

test("maps server directory entries into Pierre paths", () => {
  expect(
    treeEntries("src/", [
      { name: "components", type: "directory" },
      { name: "index.ts", type: "file" },
    ]),
  ).toEqual(["src/components/", "src/index.ts"])
})

test("maps Pierre paths back to the selected server root", () => {
  expect(absoluteTreePath("C:/Users/luke", "src/components/")).toBe("C:/Users/luke/src/components")
  expect(absoluteTreePath("/home/luke", "README.md")).toBe("/home/luke/README.md")
})

test("includes files only when the picker selects files", () => {
  const nodes = [
    { name: "components", type: "directory" as const },
    { name: "index.ts", type: "file" as const },
  ]
  expect(pickerTreeEntries("", nodes, "directory")).toEqual(["components/"])
  expect(pickerTreeEntries("", nodes, "file")).toEqual(["components/", "index.ts"])
})

test("includes files in file autocomplete while preserving directory navigation", () => {
  const nodes = [
    { name: "src", absolute: "/repo/src", type: "directory" as const },
    { name: "README.md", absolute: "/repo/README.md", type: "file" as const },
  ]
  expect(pickerSearchEntries(nodes, "directory")).toEqual([nodes[0]])
  expect(pickerSearchEntries(nodes, "file")).toEqual(nodes)
})

test("centralizes file and directory selection policy", () => {
  const file = pickerMode("file", "/repo")
  expect(file.includeFiles).toBeTrue()
  expect(file.selection("/repo/src", "index.ts")).toBe("src/index.ts")
  expect(file.selection("/repo", "src/")).toBeUndefined()
  expect(file.result("/repo", "src/index.ts")).toBe("src/index.ts")

  const directory = pickerMode("directory")
  expect(directory.includeFiles).toBeFalse()
  expect(directory.selection("/repo", "src/")).toBe("/repo/src")
  expect(directory.result("/repo", "")).toBe("/repo")
})

test("scopes file autocomplete to the current browser root", () => {
  expect(pickerFileSearchQuery("/home/luke/repos", "/home/luke/repos/src/in", "/home/luke")).toBe("src/in")
  expect(pickerFileSearchQuery("/home/luke", "~/repos/op", "/home/luke")).toBe("repos/op")
})

test("identifies the next directory level to preload", () => {
  expect(
    preloadTreeDirectories("src/", [
      { name: "components", type: "directory" },
      { name: "index.ts", type: "file" },
      { name: "utils", type: "directory" },
    ]),
  ).toEqual(["src/components/", "src/utils/"])
})

test("advances preloading once for every expanded directory", () => {
  const advanced = new Set<string>()
  expect(advanceTreePreload(advanced, "")).toBeTrue()
  expect(advanceTreePreload(advanced, "")).toBeFalse()
  expect(advanceTreePreload(advanced, "repos/")).toBeTrue()
})

test("clamps bridged tree wheel scrolling", () => {
  expect(nextTreeScrollTop(100, 40, 500, 200)).toBe(140)
  expect(nextTreeScrollTop(10, -40, 500, 200)).toBe(0)
  expect(nextTreeScrollTop(290, 40, 500, 200)).toBe(300)
})

test("wraps autocomplete keyboard navigation", () => {
  expect(nextSuggestionIndex(-1, 1, 4)).toBe(0)
  expect(nextSuggestionIndex(3, 1, 4)).toBe(0)
  expect(nextSuggestionIndex(0, -1, 4)).toBe(3)
  expect(nextSuggestionIndex(0, 1, 0)).toBe(-1)
})

test("returns absolute directories and relative files", () => {
  expect(selectedTreePath("/home/luke/repo", "src/", "directory")).toBe("/home/luke/repo/src")
  expect(selectedTreePath("/home/luke/repo", "src/index.ts", "file")).toBe("src/index.ts")
  expect(selectedTreePath("/home/luke/repo/src", "index.ts", "file", "/home/luke/repo")).toBe("src/index.ts")
  expect(selectedTreePath("/home/luke/repo", "src/", "file")).toBeUndefined()
})
