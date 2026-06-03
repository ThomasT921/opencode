export * as SessionPartModelData from "./model-data"

import type { SessionV1 } from "../v1/session"

type V1PartData<Data extends SessionV1.Part = SessionV1.Part> = Data extends SessionV1.Part
  ? Omit<Data, "id" | "sessionID" | "messageID">
  : never

export const THRESHOLD = 64 * 1024

// Strip UI-only metadata only when the stored prompt projection benefits.
export function create(data: unknown): V1PartData | null {
  if (!data || typeof data !== "object") return null
  if (!("type" in data) || data.type !== "tool") return null
  if (!("state" in data) || !data.state || typeof data.state !== "object") return null
  if (!("status" in data.state) || data.state.status !== "completed") return null
  if (!("metadata" in data.state)) return null
  const metadata = JSON.stringify(data.state.metadata)
  if (!metadata || Buffer.byteLength(metadata) <= THRESHOLD) return null
  const { metadata: _, ...state } = data.state
  return { ...data, state } as V1PartData
}
