import { Database } from "@/storage/db"
import { Context, Effect, Layer } from "effect"
import type { EffectSQLiteDatabase } from "@opencode-ai/effect-drizzle-sqlite"
import * as StorageSchema from "@/storage/schema"

export class Service extends Context.Service<Service, EffectSQLiteDatabase<typeof StorageSchema>>()(
  "@opencode/DatabaseEffect",
) {}

export const layer = Layer.effect(Service, Effect.sync(Database.Client))

export * as DatabaseEffect from "./db-effect"
