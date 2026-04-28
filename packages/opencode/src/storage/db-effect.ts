import { Database } from "@/storage/db"
import * as StorageSchema from "@/storage/schema"
import { Context, Layer } from "effect"
import { drizzle, type EffectSQLiteDatabase } from "@opencode-ai/effect-drizzle-sqlite"

const schema = { ...StorageSchema }

export class Service extends Context.Service<Service, EffectSQLiteDatabase<typeof schema>>()("@opencode/DatabaseEffect") {}

export const layer = Layer.sync(Service, () => drizzle({ client: Database.Client().$client, schema }))

export * as DatabaseEffect from "./db-effect"
