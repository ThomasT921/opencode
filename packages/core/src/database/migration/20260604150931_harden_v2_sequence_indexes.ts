import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260604150931_harden_v2_sequence_indexes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`event_aggregate_seq_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`event_aggregate_type_seq_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_message_session_seq_idx\`;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_uidx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_uidx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
