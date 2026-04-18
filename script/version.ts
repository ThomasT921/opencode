#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"

const output = [`version=${Script.version}`]
const sha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()
const repo = process.env.GH_REPO

async function releaseView() {
  if (repo) return await $`gh release view v${Script.version} --json tagName,databaseId --repo ${repo}`.json()
  return await $`gh release view v${Script.version} --json tagName,databaseId`.json()
}

async function ensureRelease(notesFile?: string) {
  const existing = repo
    ? await $`gh release view v${Script.version} --json tagName,databaseId --repo ${repo}`.nothrow()
    : await $`gh release view v${Script.version} --json tagName,databaseId`.nothrow()
  if (existing.exitCode === 0) return await releaseView()
  if (notesFile) {
    if (repo) {
      await $`gh release create v${Script.version} -d --target ${sha} --title "v${Script.version}" --notes-file ${notesFile} --repo ${repo}`
      return await releaseView()
    }
    await $`gh release create v${Script.version} -d --target ${sha} --title "v${Script.version}" --notes-file ${notesFile}`
    return await releaseView()
  }
  if (repo) {
    await $`gh release create v${Script.version} -d --target ${sha} --title "v${Script.version}" --repo ${repo}`
    return await releaseView()
  }
  await $`gh release create v${Script.version} -d --target ${sha} --title "v${Script.version}"`
  return await releaseView()
}

if (!Script.preview) {
  await $`bun script/changelog.ts --to ${sha}`.cwd(process.cwd())
  const file = `${process.cwd()}/UPCOMING_CHANGELOG.md`
  const body = await Bun.file(file)
    .text()
    .catch(() => "No notable changes")
  const dir = process.env.RUNNER_TEMP ?? "/tmp"
  const notesFile = `${dir}/opencode-release-notes.txt`
  await Bun.write(notesFile, body)
  const release = await ensureRelease(notesFile)
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
} else if (Script.channel === "beta") {
  const release = await ensureRelease()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
}

output.push(`repo=${process.env.GH_REPO}`)

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
