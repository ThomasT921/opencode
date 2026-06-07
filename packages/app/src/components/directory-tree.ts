export function treeEntries(parent: string, nodes: ReadonlyArray<{ name: string; type: "file" | "directory" }>) {
  const prefix = parent.replace(/^\/+|\/+$/g, "")
  return nodes.map((node) => {
    const path = prefix ? `${prefix}/${node.name}` : node.name
    return node.type === "directory" ? path + "/" : path
  })
}

export function pickerTreeEntries(
  parent: string,
  nodes: ReadonlyArray<{ name: string; type: "file" | "directory" }>,
  mode: "directory" | "file",
) {
  return treeEntries(parent, mode === "directory" ? nodes.filter((node) => node.type === "directory") : nodes)
}

export function pickerSearchEntries<T extends { type: "file" | "directory" }>(
  nodes: readonly T[],
  mode: "directory" | "file",
) {
  return mode === "directory" ? nodes.filter((node) => node.type === "directory") : [...nodes]
}

export function pickerMode(mode: "directory" | "file", base?: string) {
  if (mode === "file") {
    return {
      includeFiles: true,
      action: "Select file",
      entries(parent: string, nodes: ReadonlyArray<{ name: string; type: "file" | "directory" }>) {
        return treeEntries(parent, nodes)
      },
      navigation(path: string) {
        return treePathWithin(base, path) ? path : undefined
      },
      result(root: string, selected: string) {
        return selected || undefined
      },
      selection(root: string, path: string) {
        if (!treePathWithin(base, root)) return
        return selectedTreePath(root, path, "file", base)
      },
    }
  }
  return {
    includeFiles: false,
    action: "Select folder",
    entries(parent: string, nodes: ReadonlyArray<{ name: string; type: "file" | "directory" }>) {
      return treeEntries(
        parent,
        nodes.filter((node) => node.type === "directory"),
      )
    },
    navigation(path: string) {
      return path
    },
    result(root: string, selected: string, valid = true) {
      if (!valid) return
      return selected || root || undefined
    },
    selection(root: string, path: string) {
      return selectedTreePath(root, path, "directory")
    },
  }
}

export function pickerFileSearchQuery(root: string, input: string, home: string) {
  const value = input.replace(/\\/g, "/").replace(/^~(?=\/|$)/, home).replace(/\/+$/, "")
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "")
  if (value === base) return ""
  if (value.startsWith(base + "/")) return value.slice(base.length + 1)
  return value
}

export function pickerAbsoluteInput(input: string, home: string) {
  return input.replace(/\\/g, "/").replace(/^~(?=\/|$)/, home).replace(/\/+$/, "") || "/"
}

export function treePathWithin(base: string | undefined, path: string) {
  if (!base) return false
  const root = absoluteTreePath(base, "").toLowerCase()
  const target = absoluteTreePath(path, "").toLowerCase()
  return target === root || target.startsWith(root + "/")
}

export function preloadTreeDirectories(
  parent: string,
  nodes: ReadonlyArray<{ name: string; type: "file" | "directory" }>,
) {
  return treeEntries(
    parent,
    nodes.filter((node) => node.type === "directory"),
  )
}

export function advanceTreePreload(advanced: Set<string>, path: string) {
  if (advanced.has(path)) return false
  advanced.add(path)
  return true
}

export function activeTreeNavigation(request: number, current: number) {
  return request === current
}

export function nextTreeScrollTop(current: number, delta: number, scrollHeight: number, clientHeight: number) {
  return Math.min(Math.max(0, scrollHeight - clientHeight), Math.max(0, current + delta))
}

export function nextSuggestionIndex(current: number, delta: -1 | 1, count: number) {
  if (count === 0) return -1
  return (current + delta + count) % count
}

export function absoluteTreePath(root: string, path: string) {
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "")
  const relative = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  if (!relative) return base || "/"
  if (!base || base === "/") return "/" + relative
  return `${base}/${relative}`
}

export function selectedTreePath(root: string, path: string, mode: "directory" | "file", base?: string) {
  const directory = path.endsWith("/")
  if (mode === "file") {
    if (directory) return
    if (!base) return path
    const absolute = absoluteTreePath(root, path)
    const prefix = absoluteTreePath(base, "")
    if (absolute === prefix) return ""
    if (absolute.startsWith(prefix + "/")) return absolute.slice(prefix.length + 1)
    return absolute
  }
  return directory ? absoluteTreePath(root, path) : undefined
}
