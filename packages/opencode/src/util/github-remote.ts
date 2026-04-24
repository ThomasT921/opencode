function normalize(input: string) {
  return input.trim().replace(/^git\+/, "").replace(/#.*$/, "")
}

export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const match = normalize(url).match(/^(?:(?:https?|ssh|git):\/\/)?(?:git@)?github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!match) return null
  return { owner: match[1], repo: match[2] }
}

export function parseGitHubRepository(input: string): { owner: string; repo: string } | null {
  const cleaned = normalize(input)
  const remote = parseGitHubRemote(cleaned)
  if (remote) return remote

  const prefixed = cleaned.match(/^github:([^/\s]+)\/([^/\s]+)$/)
  if (prefixed) {
    return { owner: prefixed[1], repo: prefixed[2].replace(/\.git$/, "") }
  }

  const match = cleaned.match(/^([^/\s]+)\/([^/\s]+)$/)
  if (!match) return null
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") }
}

export function githubRepositoryURL(input: { owner: string; repo: string }) {
  return `https://github.com/${input.owner}/${input.repo}`
}

export function githubCloneURL(input: { owner: string; repo: string }) {
  const base = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
  if (!base) return `https://github.com/${input.owner}/${input.repo}.git`
  return new URL(`${input.owner}/${input.repo}.git`, base.endsWith("/") ? base : `${base}/`).href
}
