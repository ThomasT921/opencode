import { expect } from "bun:test"
import { ProjectID } from "@/project/schema"
import { ProjectTable } from "@/project/project.sql"
import { SessionID } from "@/session/schema"
import { SessionMessageTable, SessionTable } from "@/session/session.sql"
import { SessionStorage } from "@/v2/storage/session"
import { StorageDatabase } from "@/v2/storage/database"
import { SessionStorageMemory } from "@/v2/storage/session-memory"
import { SessionStorageSql } from "@/v2/storage/session-sql"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionMessage } from "@opencode-ai/core/session-message"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { eq, or } from "@/storage/db"
import { DateTime, Effect, Layer, Schema } from "effect"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const projectID = ProjectID.make("project-session-storage")
const sessionA = SessionID.make("ses_storage_a")
const sessionB = SessionID.make("ses_storage_b")
const sessionC = SessionID.make("ses_storage_c")
const sessionD = SessionID.make("ses_storage_d")
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const memoryState = {
  sessions: new Map(),
  messages: new Map(),
}
const memoryLayer = Layer.sync(SessionStorage.Service, () => SessionStorageMemory.make(memoryState))

interface Seeds<R> {
  readonly reset: Effect.Effect<void, never, R>
  readonly project: Effect.Effect<void, never, R>
  readonly session: (input: {
    id: SessionID
    title: string
    directory?: string
    path: string
    updated: number
  }) => Effect.Effect<void, never, R>
  readonly userMessage: (input: { id: SessionMessage.ID; text: string; time: number }) => Effect.Effect<void, never, R>
  readonly compaction: (input: {
    id: SessionMessage.ID
    summary: string
    time: number
  }) => Effect.Effect<void, never, R>
}

function sessionStorageContract<R, E>(name: string, layer: Layer.Layer<SessionStorage.Service | R, E>, seed: Seeds<R>) {
  const it = testEffect(layer)

  const setup = Effect.gen(function* () {
    yield* seed.reset
    yield* Effect.addFinalizer(() => seed.reset)
    yield* seed.project
  })

  it.effect(`${name}: gets and lists sessions with filters and cursors`, () =>
    Effect.gen(function* () {
      yield* setup
      yield* seed.session({
        id: sessionA,
        title: "Alpha",
        directory: "/tmp/project-session-storage",
        path: "apps/api",
        updated: 1000,
      })
      yield* seed.session({
        id: sessionB,
        title: "Beta",
        directory: "/tmp/project-session-storage",
        path: "apps/web",
        updated: 2000,
      })
      yield* seed.session({
        id: sessionC,
        title: "Gamma",
        path: "docs",
        updated: 3000,
      })
      yield* seed.session({
        id: sessionD,
        title: "Delta",
        directory: "/tmp/other-project",
        path: "other",
        updated: 4000,
      })

      const storage = yield* SessionStorage.Service
      const found = yield* storage.get(sessionB)
      expect(found?.title).toBe("Beta")
      expect(found ? DateTime.toEpochMillis(found.time.updated) : undefined).toBe(2000)

      expect(
        (yield* storage.list({ directory: "/tmp/project-session-storage", path: "apps", order: "asc" })).map(
          (row) => row.id,
        ),
      ).toEqual([sessionA, sessionB])
      expect(
        (yield* storage.list({ directory: "/tmp/project-session-storage", order: "asc" })).map((row) => row.id),
      ).toEqual([sessionA, sessionB, sessionC])
      expect(
        (yield* storage.list({
          directory: "/tmp/project-session-storage",
          order: "asc",
          cursor: { id: sessionA, time: 1000, direction: "next" },
        })).map((row) => row.id),
      ).toEqual([sessionB, sessionC])
      expect(
        (yield* storage.list({
          directory: "/tmp/project-session-storage",
          order: "asc",
          cursor: { id: sessionC, time: 3000, direction: "previous" },
        })).map((row) => row.id),
      ).toEqual([sessionA, sessionB])
    }),
  )

  it.effect(`${name}: lists session messages with cursor direction`, () =>
    Effect.gen(function* () {
      yield* setup
      yield* seed.session({ id: sessionA, title: "Alpha", path: "apps/api", updated: 1000 })
      yield* seed.userMessage({ id: EventV2.ID.make("evt_msg_1"), text: "one", time: 1000 })
      yield* seed.userMessage({ id: EventV2.ID.make("evt_msg_2"), text: "two", time: 2000 })
      yield* seed.userMessage({ id: EventV2.ID.make("evt_msg_3"), text: "three", time: 3000 })

      const storage = yield* SessionStorage.Service

      expect((yield* storage.messages({ sessionID: sessionA, order: "asc", limit: 2 })).map((row) => row.id)).toEqual([
        EventV2.ID.make("evt_msg_1"),
        EventV2.ID.make("evt_msg_2"),
      ])
      expect(
        (yield* storage.messages({
          sessionID: sessionA,
          order: "asc",
          cursor: { id: EventV2.ID.make("evt_msg_3"), time: 3000, direction: "previous" },
        })).map((row) => row.id),
      ).toEqual([EventV2.ID.make("evt_msg_1"), EventV2.ID.make("evt_msg_2")])
    }),
  )

  it.effect(`${name}: returns context from the latest compaction boundary`, () =>
    Effect.gen(function* () {
      yield* setup
      yield* seed.session({ id: sessionA, title: "Alpha", path: "apps/api", updated: 1000 })
      yield* seed.userMessage({ id: EventV2.ID.make("evt_context_1"), text: "before", time: 1000 })
      yield* seed.compaction({ id: EventV2.ID.make("evt_context_2"), summary: "compact", time: 2000 })
      yield* seed.userMessage({ id: EventV2.ID.make("evt_context_3"), text: "after", time: 3000 })

      const storage = yield* SessionStorage.Service
      const context = yield* storage.context(sessionA)

      expect(context.map((message) => message.id)).toEqual([
        EventV2.ID.make("evt_context_2"),
        EventV2.ID.make("evt_context_3"),
      ])
      expect(context.map((message) => message.type)).toEqual(["compaction", "user"])
    }),
  )
}

const testDatabaseLayer = Layer.unwrap(
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    return Layer.effect(
      StorageDatabase.Service,
      Effect.gen(function* () {
        const db = yield* StorageDatabase.Service
        yield* EffectDrizzleSqlite.migrate(db, { migrationsFolder: path.join(import.meta.dirname, "../../migration") })
        return db
      }),
    ).pipe(Layer.provide(StorageDatabase.layerForPath(path.join(dir.path, "storage.db"))))
  }),
)

const sqlLayer = SessionStorageSql.layer.pipe(Layer.provideMerge(testDatabaseLayer))

const sqlSeeds: Seeds<StorageDatabase.Service> = {
  reset: resetSqlSeeds(),
  project: seedProject(),
  session: seedSession,
  userMessage: seedUserMessage,
  compaction: seedCompaction,
}

sessionStorageContract("SessionStorageSql", sqlLayer, sqlSeeds)

const memorySeeds: Seeds<never> = {
  reset: Effect.sync(() => {
    memoryState.sessions.clear()
    memoryState.messages.clear()
  }),
  project: Effect.void,
  session: (input) =>
    Effect.sync(() => {
      memoryState.sessions.set(input.id, makeSessionRow(input))
    }),
  userMessage: (input) =>
    Effect.sync(() => {
      appendMemoryMessage(makeUserMessage(input))
    }),
  compaction: (input) =>
    Effect.sync(() => {
      appendMemoryMessage(makeCompaction(input))
    }),
}

sessionStorageContract("SessionStorageMemory", memoryLayer, memorySeeds)

function seedProject() {
  return Effect.gen(function* () {
    const db = yield* StorageDatabase.Service
    yield* db
      .insert(ProjectTable)
      .values({
        id: projectID,
        worktree: "/tmp/project-session-storage",
        time_created: 1,
        time_updated: 1,
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
}

function resetSqlSeeds() {
  return Effect.gen(function* () {
    const db = yield* StorageDatabase.Service
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, sessionA)).run().pipe(Effect.orDie)
    yield* db
      .delete(SessionTable)
      .where(
        or(
          eq(SessionTable.id, sessionA),
          eq(SessionTable.id, sessionB),
          eq(SessionTable.id, sessionC),
          eq(SessionTable.id, sessionD),
        ),
      )
      .run()
      .pipe(Effect.orDie)
    yield* db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run().pipe(Effect.orDie)
  })
}

function seedSession(input: { id: SessionID; title: string; directory?: string; path: string; updated: number }) {
  return Effect.gen(function* () {
    const db = yield* StorageDatabase.Service
    yield* db
      .insert(SessionTable)
      .values({
        id: input.id,
        project_id: projectID,
        slug: input.title.toLowerCase(),
        directory: input.directory ?? "/tmp/project-session-storage",
        path: input.path,
        title: input.title,
        version: "test",
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        time_created: input.updated,
        time_updated: input.updated,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

function seedUserMessage(input: { id: SessionMessage.ID; text: string; time: number }) {
  const encoded = encodeMessage(makeUserMessage(input))
  const { id: _, type: __, ...data } = encoded
  return seedMessage(input.id, "user", input.time, data)
}

function seedCompaction(input: { id: SessionMessage.ID; summary: string; time: number }) {
  const encoded = encodeMessage(makeCompaction(input))
  const { id: _, type: __, ...data } = encoded
  return seedMessage(input.id, "compaction", input.time, data)
}

function makeSessionRow(input: { id: SessionID; title: string; directory?: string; path: string; updated: number }) {
  return new SessionStorage.SessionRow({
    id: input.id,
    projectID,
    title: input.title,
    directory: input.directory ?? "/tmp/project-session-storage",
    path: input.path,
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    time: {
      created: DateTime.makeUnsafe(input.updated),
      updated: DateTime.makeUnsafe(input.updated),
    },
  })
}

function makeUserMessage(input: { id: SessionMessage.ID; text: string; time: number }) {
  return new SessionMessage.User({
    id: input.id,
    type: "user",
    text: input.text,
    files: [],
    agents: [],
    references: [],
    time: { created: DateTime.makeUnsafe(input.time) },
  })
}

function makeCompaction(input: { id: SessionMessage.ID; summary: string; time: number }) {
  return new SessionMessage.Compaction({
    id: input.id,
    type: "compaction",
    reason: "manual",
    summary: input.summary,
    time: { created: DateTime.makeUnsafe(input.time) },
  })
}

function seedMessage(
  id: SessionMessage.ID,
  type: SessionMessage.Type,
  time: number,
  data: typeof SessionMessageTable.$inferInsert.data,
) {
  return Effect.gen(function* () {
    const db = yield* StorageDatabase.Service
    yield* db
      .insert(SessionMessageTable)
      .values({
        id,
        session_id: sessionA,
        type,
        time_created: time,
        time_updated: time,
        data,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

function appendMemoryMessage(message: SessionMessage.Message) {
  const current = memoryState.messages.get(sessionA) ?? []
  current.push(message)
  memoryState.messages.set(sessionA, current)
}
