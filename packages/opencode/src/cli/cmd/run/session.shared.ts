// Session message extraction and prompt history.
//
// Fetches session messages from the SDK and extracts user turn text for
// the prompt history ring. Also finds the most recently used variant for
// the current model so the footer can pre-select it.
import path from "path"
import { fileURLToPath } from "url"
import type { RunInput, RunPrompt } from "./types"

const LIMIT = 200

export type SessionMessages = NonNullable<Awaited<ReturnType<RunInput["sdk"]["session"]["messages"]>>["data"]>

type Turn = {
  prompt: RunPrompt
  provider: string | undefined
  model: string | undefined
  variant: string | undefined
}

export type RunSession = {
  first: boolean
  turns: Turn[]
}

function copy(prompt: RunPrompt): RunPrompt {
  return {
    text: prompt.text,
    parts: structuredClone(prompt.parts),
  }
}

function same(a: RunPrompt, b: RunPrompt): boolean {
  return a.text === b.text && JSON.stringify(a.parts) === JSON.stringify(b.parts)
}

function fileName(url: string, filename?: string) {
  if (filename) {
    return filename
  }

  try {
    const next = new URL(url)
    if (next.protocol === "file:") {
      return path.basename(fileURLToPath(next)) || url
    }
  } catch {}

  return url
}

function fileSource(
  part: Extract<SessionMessages[number]["parts"][number], { type: "file" }>,
  text: { start: number; end: number; value: string },
) {
  if (part.source) {
    return {
      ...structuredClone(part.source),
      text,
    }
  }

  return {
    type: "file" as const,
    path: part.filename ?? part.url,
    text,
  }
}

function prompt(msg: SessionMessages[number]): RunPrompt {
  const files: Array<Extract<SessionMessages[number]["parts"][number], { type: "file" }>> = []
  const parts: RunPrompt["parts"] = []
  for (const part of msg.parts) {
    if (part.type === "file") {
      if (!part.source?.text) {
        files.push(part)
        continue
      }

      parts.push({
        type: "file",
        mime: part.mime,
        filename: part.filename,
        url: part.url,
        source: structuredClone(part.source),
      })
      continue
    }

    if (part.type === "agent" && part.source) {
      parts.push({
        type: "agent",
        name: part.name,
        source: structuredClone(part.source),
      })
    }
  }

  let text = msg.parts
    .filter((part): part is Extract<SessionMessages[number]["parts"][number], { type: "text" }> => {
      return part.type === "text" && !part.synthetic
    })
    .map((part) => part.text)
    .join("")
  let cursor = Bun.stringWidth(text)

  for (const part of files) {
    const value = "@" + fileName(part.url, part.filename)
    const gap = text ? " " : ""
    const start = cursor + Bun.stringWidth(gap)
    text += gap + value
    const end = start + Bun.stringWidth(value)
    cursor = end
    parts.push({
      type: "file",
      mime: part.mime,
      filename: part.filename,
      url: part.url,
      source: fileSource(part, {
        start,
        end,
        value,
      }),
    })
  }

  return { text, parts }
}

function turn(msg: SessionMessages[number]): Turn | undefined {
  if (msg.info.role !== "user") {
    return
  }

  return {
    prompt: prompt(msg),
    provider: msg.info.model.providerID,
    model: msg.info.model.modelID,
    variant: msg.info.model.variant,
  }
}

export function createSession(messages: SessionMessages): RunSession {
  return {
    first: messages.length === 0,
    turns: messages.flatMap((msg) => {
      const item = turn(msg)
      return item ? [item] : []
    }),
  }
}

export async function resolveSession(sdk: RunInput["sdk"], sessionID: string, limit = LIMIT): Promise<RunSession> {
  const response = await sdk.session.messages({
    sessionID,
    limit,
  })
  return createSession(response.data ?? [])
}

export function sessionHistory(session: RunSession, limit = LIMIT): RunPrompt[] {
  const out: RunPrompt[] = []

  for (const turn of session.turns) {
    if (!turn.prompt.text.trim()) {
      continue
    }

    if (out[out.length - 1] && same(out[out.length - 1], turn.prompt)) {
      continue
    }

    out.push(copy(turn.prompt))
  }

  return out.slice(-limit)
}

export function sessionVariant(session: RunSession, model: RunInput["model"]): string | undefined {
  if (!model) {
    return
  }

  for (let idx = session.turns.length - 1; idx >= 0; idx -= 1) {
    const turn = session.turns[idx]
    if (turn.provider !== model.providerID || turn.model !== model.modelID) {
      continue
    }

    return turn.variant
  }
}
