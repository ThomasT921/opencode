import { Database } from "bun:sqlite"
import { drizzle } from "@opencode-ai/effect-drizzle-sqlite"

export function init<TSchema extends Record<string, unknown>>(path: string, schema: TSchema) {
  return drizzle({ client: new Database(path, { create: true }), schema })
}
