import { and, asc, desc, eq, gt, gte, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionContextMessageTable, SessionMessageTable } from "./sql"
import type { SystemContext } from "../system-context"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)
export type RunnerMessage =
  | SessionMessage.Message
  | { readonly type: "system-context"; readonly parts: ReadonlyArray<SystemContext.Part> }

const latestCompaction = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

const messageRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: typeof SessionMessageTable.$inferSelect | undefined,
) {
  return yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction ? or(gte(SessionMessageTable.seq, compaction.seq)) : undefined,
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
})

const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

export const load = Effect.fn("SessionContext.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* Effect.forEach(
    yield* messageRows(db, sessionID, yield* latestCompaction(db, sessionID)),
    decodeMessageRow,
  )
})

export const loadForRunner = Effect.fn("SessionContext.loadForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const compaction = yield* latestCompaction(db, sessionID)
  const messages = yield* messageRows(db, sessionID, compaction)
  const epoch = yield* db
    .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
    .from(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  const updates = yield* db
    .select()
    .from(SessionContextMessageTable)
    .where(
      and(
        eq(SessionContextMessageTable.session_id, sessionID),
        epoch ? gt(SessionContextMessageTable.seq, epoch.baselineSeq) : undefined,
      ),
    )
    .orderBy(asc(SessionContextMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return yield* Effect.forEach(
    merge(
      messages.map((row) => ({ type: "message" as const, seq: row.seq, row })),
      updates.map((row) => ({ type: "system-context" as const, seq: row.seq, row })),
    ),
    (item): Effect.Effect<RunnerMessage, MessageDecodeError> =>
      item.type === "message"
        ? decodeMessageRow(item.row)
        : Effect.succeed({ type: "system-context", parts: item.row.parts }),
  )
})

function merge<Left extends { readonly seq: number }, Right extends { readonly seq: number }>(
  left: ReadonlyArray<Left>,
  right: ReadonlyArray<Right>,
): Array<Left | Right> {
  const result: Array<Left | Right> = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length || rightIndex < right.length) {
    if (rightIndex >= right.length || (leftIndex < left.length && left[leftIndex].seq < right[rightIndex].seq)) {
      result.push(left[leftIndex])
      leftIndex++
      continue
    }
    result.push(right[rightIndex])
    rightIndex++
  }
  return result
}

export * as SessionContext from "./context"
