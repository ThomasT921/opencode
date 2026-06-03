import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260603120017_warm_guardsmen",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`part\` ADD \`data_model\` text;`)
      // Keep canonical history intact while avoiding prompt-time decoding. This
      // one-time transactional backfill may briefly grow the WAL on large stores.
      yield* tx.run(`
        UPDATE part
        SET data_model = json_remove(data, '$.state.metadata')
        WHERE length(CAST(data AS BLOB)) > 65536
          AND json_extract(data, '$.type') = 'tool'
          AND json_extract(data, '$.state.status') = 'completed'
          AND length(CAST(json_extract(data, '$.state.metadata') AS BLOB)) > 65536
      `)
    })
  },
} satisfies DatabaseMigration.Migration
