import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260604181329_add_session_context_updates",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_context_message\` (
          \`session_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`parts\` text NOT NULL,
          CONSTRAINT \`session_context_message_pk\` PRIMARY KEY(\`session_id\`, \`seq\`),
          CONSTRAINT \`fk_session_context_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` ADD \`revision\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(
        `CREATE INDEX \`session_context_message_session_seq_idx\` ON \`session_context_message\` (\`session_id\`,\`seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
