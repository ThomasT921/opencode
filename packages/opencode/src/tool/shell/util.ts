import path from "path"
import os from "os"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { Shell } from "@/shell/shell"
import { Truncate } from "../truncate"
import { Instance } from "@/project/instance"
import { Tool } from "../tool"
import { fileURLToPath } from "url"

export type Part = {
  type: string
  text: string
}

export type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

export function resolveWasm(asset: string) {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

export function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

export function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

export function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

export function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

export function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

export async function cygpath(shell: string, text: string) {
  const out = await Process.text([shell, "-lc", 'cygpath -w -- "$1"', "_", text], { nothrow: true })
  if (out.code !== 0) return
  const file = out.text.trim()
  if (!file) return
  return Filesystem.normalizePath(file)
}

export async function resolvePath(text: string, root: string, shell: string) {
  if (process.platform === "win32") {
    if (Shell.posix(shell) && text.startsWith("/") && Filesystem.windowsPath(text) === text) {
      const file = await cygpath(shell, text)
      if (file) return file
    }
    return Filesystem.normalizePath(path.resolve(root, Filesystem.windowsPath(text)))
  }
  return path.resolve(root, text)
}

export function formatShellDescription(
  template: string,
  opts: {
    name: string
    shellName: string
    chaining: string
    guidance: string
    listCmd: string
    toolName: string
    gitCmds: string
  },
) {
  return template
    .replaceAll("${directory}", Instance.directory)
    .replaceAll("${os}", process.platform)
    .replaceAll("${shell}", opts.name)
    .replaceAll("${shellName}", opts.shellName)
    .replaceAll("${chaining}", opts.chaining)
    .replaceAll("${guidance}", opts.guidance)
    .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
    .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES))
}

import z from "zod"
import DESCRIPTION from "./shell.txt"
import { Log } from "@/util/log"
import { Flag } from "@/flag/flag"
import { ShellParser } from "./parser"
import { ShellRunner } from "./runner"

export type ShellType = "bash" | "pwsh" | "powershell"

const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000

export function createShellTool(opts: {
  id: ShellType
  shellName: string
  chaining: string
  guidance: string
  listCmd: string
  toolName: string
  gitCmds: string
}) {
  const log = Log.create({ service: `${opts.id}-tool` })

  return Tool.define(opts.id, async () => {
    const shell = Shell.acceptable()
    const name = Shell.name(shell)
    log.info(`${opts.id} tool using shell`, { shell, name })

    return {
      description: formatShellDescription(DESCRIPTION, {
        name,
        shellName: opts.shellName,
        chaining: opts.chaining,
        guidance: opts.guidance,
        listCmd: opts.listCmd,
        toolName: opts.toolName,
        gitCmds: opts.gitCmds,
      }),
      parameters: z.object({
        command: z.string().describe("The command to execute"),
        timeout: z.number().describe("Optional timeout in milliseconds").optional(),
        workdir: z
          .string()
          .describe(
            `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
          )
          .optional(),
        description: z
          .string()
          .describe(
            "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
          ),
      }),
      async execute(params, ctx) {
        const cwd = params.workdir ? await resolvePath(params.workdir, Instance.directory, shell) : Instance.directory
        if (params.timeout !== undefined && params.timeout < 0) {
          throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
        }
        const timeout = params.timeout ?? DEFAULT_TIMEOUT

        const scan = await ShellParser.collect({
          command: params.command,
          cwd,
          shell,
          shellType: opts.id,
        })
        if (!Instance.containsPath(cwd)) scan.dirs.add(cwd)

        await askPermission(ctx, scan, opts.id)

        return ShellRunner.run(
          {
            shell,
            name,
            command: params.command,
            cwd,
            env: await ShellRunner.shellEnv(ctx, cwd),
            timeout,
            description: params.description,
          },
          ctx,
        )
      },
    }
  })
}

export async function askPermission(ctx: Tool.Context, scan: Scan, permissionName: string = "bash") {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return Filesystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    await ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  await ctx.ask({
    permission: permissionName,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
}
