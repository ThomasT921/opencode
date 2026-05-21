import { Database as LegacyDatabase } from "@/storage/db"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Context, Effect, Layer } from "effect"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export class Service extends Context.Service<Service, DatabaseShape>()("@opencode/v2/storage/Database") {}

export const layerForPath = (filename: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* makeDatabase
      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA cache_size = -64000")
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
      return db
    }),
  ).pipe(Layer.provide(SqliteClient.layer({ filename })))

export const layer = Layer.unwrap(
  Effect.sync(() => {
    // TODO: Extract migration/bootstrap from the legacy Database.Client() so V2 storage
    // can ensure the schema exists without opening the old global Drizzle connection.
    LegacyDatabase.Client()
    return layerForPath(LegacyDatabase.getPath())
  }),
)

export const defaultLayer = layer

export * as StorageDatabase from "./database"
