import { Database } from "bun:sqlite"
import { drizzle as drizzleBun, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import type { AnyRelations, EmptyRelations } from "drizzle-orm/relations"
import { SQLiteCountBuilder } from "drizzle-orm/sqlite-core/query-builders/count"
import { SQLiteDeleteBase } from "drizzle-orm/sqlite-core/query-builders/delete"
import { SQLiteInsertBase } from "drizzle-orm/sqlite-core/query-builders/insert"
import { SQLiteRelationalQuery, SQLiteSyncRelationalQuery } from "drizzle-orm/sqlite-core/query-builders/_query"
import { SQLiteSelectBase } from "drizzle-orm/sqlite-core/query-builders/select"
import { SQLiteUpdateBase } from "drizzle-orm/sqlite-core/query-builders/update"
import type { PreparedQueryConfig, SQLiteSession, SQLiteTransaction, SQLiteTransactionConfig } from "drizzle-orm/sqlite-core/session"
import { SQLitePreparedQuery } from "drizzle-orm/sqlite-core/session"
import type { DrizzleConfig } from "drizzle-orm/utils"
import { Cause, Effect, Exit, Schema } from "effect"
import * as Effectable from "effect/Effectable"

export class EffectDrizzleQueryError extends Schema.TaggedErrorClass<EffectDrizzleQueryError>()(
  "EffectDrizzleQueryError",
  {
    query: Schema.String,
    params: Schema.Array(Schema.Unknown),
    cause: Schema.Unknown,
  },
) {
  override get message() {
    return `Failed query: ${this.query}\nparams: ${this.params}`
  }

  constructor(params: { readonly query: string; readonly params: ReadonlyArray<unknown>; readonly cause: unknown }) {
    super(params)
    Error.captureStackTrace?.(this, EffectDrizzleQueryError)
  }
}

export type EffectSQLiteDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRelations extends AnyRelations = EmptyRelations,
> = SQLiteBunDatabase<TSchema, TRelations> & {
  readonly $client: Database
  readonly withTransaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    config?: SQLiteTransactionConfig,
  ) => Effect.Effect<A, E, R>
}

export type MakeConfig<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRelations extends AnyRelations = EmptyRelations,
> = DrizzleConfig<TSchema, TRelations> & {
  readonly client?: Database
}

type EffectLikeQuery<A = unknown> = {
  readonly asEffect?: () => Effect.Effect<A, EffectDrizzleQueryError>
  readonly toSQL?: () => { readonly sql: string; readonly params?: readonly unknown[] }
}

type PreparedLike<A = unknown> = EffectLikeQuery<A> & {
  readonly execute: () => unknown
  readonly getQuery?: () => { readonly sql: string; readonly params?: readonly unknown[] }
}

type SelectLike<A = unknown> = EffectLikeQuery<A> & {
  readonly all: () => A
}

type GetLike<A = unknown> = EffectLikeQuery & {
  readonly get: () => A
}

type MutationLike<A = unknown> = EffectLikeQuery<A> & {
  readonly all: () => A
  readonly run: () => A
  readonly config?: { readonly returning?: unknown }
}

type CountLike = EffectLikeQuery<number> & {
  readonly session: { readonly values: (sql: unknown) => unknown[][] }
  readonly sql: unknown
}

class TransactionFailure extends Error {
  constructor(readonly effectCause: Cause.Cause<unknown>) {
    super("Effect transaction failed")
  }
}

const queryInfo = (query: EffectLikeQuery | PreparedLike) => {
  const info = "getQuery" in query && typeof query.getQuery === "function" ? query.getQuery() : query.toSQL?.()
  return {
    query: info?.sql ?? "<unknown>",
    params: [...(info?.params ?? [])],
  }
}

const queryError = (query: EffectLikeQuery | PreparedLike, cause: unknown) =>
  new EffectDrizzleQueryError({
    ...queryInfo(query),
    cause,
  })

const fromSync = <A>(query: EffectLikeQuery, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) => queryError(query, cause),
  })

const fromMutation = (query: MutationLike) => fromSync(query, () => (query.config?.returning ? query.all() : query.run()))

const fromCount = (query: CountLike) => fromSync(query, () => Number(query.session.values(query.sql)[0]?.[0] ?? 0))

export const getOne = <A>(query: GetLike<A>) => fromSync(query, () => query.get())

const fromExecuteResult = (result: unknown) => {
  if (result && typeof result === "object" && "sync" in result && typeof result.sync === "function") {
    return result.sync()
  }
  return result
}

const queryEffectProto = {
  ...Effectable.Prototype<Effect.Effect<unknown, EffectDrizzleQueryError> & EffectLikeQuery>({
    label: "DrizzleSqliteQuery",
    evaluate(this: EffectLikeQuery) {
      return this.asEffect?.() ?? Effect.die("Drizzle SQLite query is missing asEffect()")
    },
  }),
  commit(this: EffectLikeQuery) {
    return this.asEffect?.() ?? Effect.die("Drizzle SQLite query is missing asEffect()")
  },
}

const patchClass = <A>(ctor: { readonly prototype: object }, asEffect: (self: A) => Effect.Effect<unknown, EffectDrizzleQueryError>) => {
  if (Object.prototype.hasOwnProperty.call(ctor.prototype, "asEffect")) return
  Object.assign(ctor.prototype, queryEffectProto, {
    asEffect(this: A) {
      return asEffect(this)
    },
  })
}

// `patchClass` is idempotent via `hasOwnProperty` check, so calling this
// repeatedly is cheap. Patches are applied to Drizzle prototypes globally and
// survive any Database close/reopen cycle.
const patchQueryBuilders = () => {
  patchClass(SQLitePreparedQuery, (query: PreparedLike) => fromSync(query, () => fromExecuteResult(query.execute())))
  patchClass(SQLiteSelectBase, (query: SelectLike) => fromSync(query, () => query.all()))
  patchClass(SQLiteInsertBase, fromMutation)
  patchClass(SQLiteUpdateBase, fromMutation)
  patchClass(SQLiteDeleteBase, fromMutation)
  patchClass(SQLiteRelationalQuery, (query: EffectLikeQuery & { readonly executeRaw: () => unknown }) =>
    fromSync(query, () => query.executeRaw()),
  )
  patchClass(SQLiteSyncRelationalQuery, (query: EffectLikeQuery & { readonly executeRaw: () => unknown }) =>
    fromSync(query, () => query.executeRaw()),
  )
  patchClass(SQLiteCountBuilder, fromCount)
}

const attachTransaction = <
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRelations extends AnyRelations = EmptyRelations,
>(db: SQLiteBunDatabase<TSchema, TRelations> & { readonly $client: Database }): EffectSQLiteDatabase<TSchema, TRelations> => {
  const txStack: Array<SQLiteTransaction<"sync", void, TSchema, TRelations>> = []
  const bound = new WeakMap<object, Map<PropertyKey, unknown>>()
  const current = () => txStack.at(-1) ?? db
  const runTransaction = (target: SQLiteBunDatabase<TSchema, TRelations> | SQLiteTransaction<"sync", void, TSchema, TRelations>) =>
    target.transaction.bind(target) as (
      transaction: (tx: SQLiteTransaction<"sync", void, TSchema, TRelations>) => unknown,
      config?: SQLiteTransactionConfig,
    ) => unknown

  const withTransaction = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    config?: SQLiteTransactionConfig,
  ): Effect.Effect<A, E, R> =>
    Effect.context<R>().pipe(
      Effect.flatMap((context) =>
        Effect.sync(
          () =>
            runTransaction(current())((tx) => {
              txStack.push(tx)
              try {
                const exit = Effect.runSyncExit(Effect.provideContext(effect, context))
                if (Exit.isSuccess(exit)) return exit.value
                throw new TransactionFailure(exit.cause)
              } finally {
                txStack.pop()
              }
            }, config) as A,
        ).pipe(
          Effect.catchDefect((defect) =>
            defect instanceof TransactionFailure ? Effect.failCause(defect.effectCause as Cause.Cause<E>) : Effect.die(defect),
          ),
        ),
      ),
    )

  return new Proxy(db, {
    get(_target, property) {
      if (property === "withTransaction") return withTransaction
      if (property === "$client") return db.$client

      const target = current()
      const value = Reflect.get(target, property)
      if (typeof value !== "function") return value
      const methods = bound.get(target) ?? new Map<PropertyKey, unknown>()
      bound.set(target, methods)
      if (!methods.has(property)) methods.set(property, value.bind(target))
      return methods.get(property)
    },
  }) as EffectSQLiteDatabase<TSchema, TRelations>
}

export const make = <
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRelations extends AnyRelations = EmptyRelations,
>(config: MakeConfig<TSchema, TRelations> = {}): EffectSQLiteDatabase<TSchema, TRelations> => {
  patchQueryBuilders()
  return attachTransaction(
    drizzleBun({
      ...config,
      client: config.client ?? new Database(":memory:"),
    }),
  )
}

export const drizzle = make

declare module "drizzle-orm/query-promise" {
  interface QueryPromise<T> extends Effect.Effect<T, EffectDrizzleQueryError> {
    asEffect(): Effect.Effect<T, EffectDrizzleQueryError>
  }
}

declare module "drizzle-orm/sqlite-core/session" {
  interface SQLitePreparedQuery<T extends PreparedQueryConfig> extends Effect.Effect<T["execute"], EffectDrizzleQueryError> {
    asEffect(): Effect.Effect<T["execute"], EffectDrizzleQueryError>
  }
}

declare module "drizzle-orm/sqlite-core/query-builders/count" {
  interface SQLiteCountBuilder<TSession extends SQLiteSession<any, any, any, any>>
    extends Effect.Effect<number, EffectDrizzleQueryError> {
    asEffect(): Effect.Effect<number, EffectDrizzleQueryError>
  }
}
