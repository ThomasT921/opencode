import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"

export function init<TSchema extends Record<string, unknown>>(path: string, schema: TSchema) {
  return drizzle({ client: new DatabaseSync(path), schema })
}
