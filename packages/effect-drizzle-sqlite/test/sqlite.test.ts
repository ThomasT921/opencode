import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { eq } from "drizzle-orm"
import { relations } from "drizzle-orm/_relations"
import { drizzle as drizzleBun } from "drizzle-orm/bun-sqlite"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Cause, Effect, Exit } from "effect"
import { EffectDrizzleQueryError, getOne, make, type EffectSQLiteDatabase } from "../src"

const users = sqliteTable("users", {
  id: integer().primaryKey(),
  name: text().notNull(),
})

const posts = sqliteTable("posts", {
  id: integer().primaryKey(),
  user_id: integer()
    .notNull()
    .references(() => users.id),
  title: text().notNull(),
})

const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}))

const postsRelations = relations(posts, ({ one }) => ({
  user: one(users, {
    fields: [posts.user_id],
    references: [users.id],
  }),
}))

const schema = { users, posts, usersRelations, postsRelations }

let db: EffectSQLiteDatabase<typeof schema>

const testEffect = <A, E>(name: string, effect: () => Effect.Effect<A, E>) => test(name, () => Effect.runPromise(effect()))

beforeEach(() => {
  db = make({ schema })
  db.$client.run("PRAGMA foreign_keys = ON")
  db.$client.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
  db.$client.run(
    "CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL)",
  )
})

afterEach(() => {
  db.$client.close()
})

describe("effect drizzle sqlite", () => {
  test("keeps normal Drizzle Bun SQLite clients usable after patching", async () => {
    const sqlite = new Database(":memory:")
    try {
      const normal = drizzleBun({ client: sqlite })
      sqlite.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")

      normal.insert(users).values({ id: 1, name: "Ada" }).run()

      expect(normal.select().from(users).all()).toEqual([{ id: 1, name: "Ada" }])
      expect(await normal.select().from(users)).toEqual([{ id: 1, name: "Ada" }])
    } finally {
      sqlite.close()
    }
  })

  testEffect("makes select/insert/update/delete query builders yieldable Effects", () =>
    Effect.gen(function* () {
      yield* db.insert(users).values({ id: 1, name: "Ada" })
      yield* db.insert(users).values({ id: 2, name: "Grace" })

      const selected = yield* db.select().from(users).orderBy(users.id)
      expect(selected).toEqual([
        { id: 1, name: "Ada" },
        { id: 2, name: "Grace" },
      ])

      const updated = yield* db.update(users).set({ name: "Lovelace" }).where(eq(users.id, 1)).returning()
      expect(updated).toEqual([{ id: 1, name: "Lovelace" }])

      const deleted = yield* db.delete(users).where(eq(users.id, 2)).returning({ id: users.id })
      expect(deleted).toEqual([{ id: 2 }])

      expect(yield* db.select().from(users)).toEqual([{ id: 1, name: "Lovelace" }])
    }),
  )

  testEffect("supports direct Effect combinators on queries", () =>
    Effect.gen(function* () {
      yield* db.insert(users).values({ id: 1, name: "Ada" })

      expect(
        yield* (db.select().from(users) as Effect.Effect<Array<{ readonly name: string }>, EffectDrizzleQueryError>).pipe(
          Effect.map((rows) => rows.map((row) => row.name)),
        ),
      ).toEqual(["Ada"])
    }),
  )

  testEffect("supports relational query builders", () =>
    Effect.gen(function* () {
      yield* db.insert(users).values({ id: 1, name: "Ada" })
      yield* db.insert(posts).values({ id: 1, user_id: 1, title: "Notes" })
      expect(
        yield* db._query.users.findMany({
          with: {
            posts: true,
          },
        }),
      ).toEqual([
        {
          id: 1,
          name: "Ada",
          posts: [{ id: 1, user_id: 1, title: "Notes" }],
        },
      ])
    }),
  )

  testEffect("runs synchronous Effect programs inside transactions", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* db.insert(users).values({ id: 1, name: "Ada" })
        return yield* db.select().from(users)
      }).pipe(db.withTransaction)

      expect(yield* db.select().from(users)).toEqual([{ id: 1, name: "Ada" }])

      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* db.insert(users).values({ id: 2, name: "Grace" })
          return yield* Effect.fail("rollback")
        }).pipe(db.withTransaction),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* db.select().from(users).orderBy(users.id)).toEqual([{ id: 1, name: "Ada" }])
    }),
  )

  testEffect("supports pipeable transactions using the same database service", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.gen(function* () {
        yield* db.insert(users).values({ id: 1, name: "Ada" })
        return yield* Effect.fail("rollback")
      }).pipe(db.withTransaction, Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* db.select().from(users)).toEqual([])

      yield* Effect.gen(function* () {
        yield* db.insert(users).values({ id: 2, name: "Grace" })
        expect(yield* db.$count(users)).toBe(1)
      }).pipe(db.withTransaction)

      expect(yield* db.select().from(users)).toEqual([{ id: 2, name: "Grace" }])
    }),
  )

  testEffect("supports count builders and prepared queries", () =>
    Effect.gen(function* () {
      yield* db.insert(users).values([
        { id: 1, name: "Ada" },
        { id: 2, name: "Grace" },
      ])

      expect(yield* db.$count(users)).toBe(2)

      const prepared = db.select().from(users).orderBy(users.id).prepare()
      expect(yield* prepared).toEqual([
        { id: 1, name: "Ada" },
        { id: 2, name: "Grace" },
      ])
    }),
  )

  testEffect("supports single-row select effects", () =>
    Effect.gen(function* () {
      yield* db.insert(users).values({ id: 1, name: "Ada" })

      expect(yield* getOne(db.select().from(users).where(eq(users.id, 1)))).toEqual({ id: 1, name: "Ada" })
      expect(yield* getOne(db.select().from(users).where(eq(users.id, 2)))).toBeUndefined()
    }),
  )

  testEffect("nested pipeable transactions commit or roll back with the outer transaction", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* db.insert(users).values({ id: 1, name: "Ada" })
        yield* Effect.gen(function* () {
          yield* db.insert(users).values({ id: 2, name: "Grace" })
        }).pipe(db.withTransaction)
      }).pipe(db.withTransaction)

      expect(yield* db.select().from(users).orderBy(users.id)).toEqual([
        { id: 1, name: "Ada" },
        { id: 2, name: "Grace" },
      ])

      const exit = yield* Effect.gen(function* () {
        yield* db.insert(users).values({ id: 3, name: "Katherine" })
        yield* Effect.gen(function* () {
          yield* db.insert(users).values({ id: 4, name: "Dorothy" })
          return yield* Effect.fail("inner rollback")
        }).pipe(db.withTransaction)
      }).pipe(db.withTransaction, Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* db.select().from(users).orderBy(users.id)).toEqual([
        { id: 1, name: "Ada" },
        { id: 2, name: "Grace" },
      ])
    }),
  )

  testEffect("defects inside transactions roll back and stay defects", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.gen(function* () {
        yield* db.insert(users).values({ id: 1, name: "Ada" })
        return yield* Effect.die("boom")
      }).pipe(db.withTransaction, Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(true)
      }
      expect(yield* db.select().from(users)).toEqual([])
    }),
  )

  testEffect("wraps query failures with query text and parameters", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(db.insert(posts).values({ id: 1, user_id: 404, title: "Missing" }))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = exit.cause.reasons.filter(Cause.isFailReason)[0]?.error
        expect(error).toBeInstanceOf(EffectDrizzleQueryError)
        expect((error as EffectDrizzleQueryError).query).toContain("insert into")
        expect((error as EffectDrizzleQueryError).params).toEqual([1, 404, "Missing"])
      }
    }),
  )
})
