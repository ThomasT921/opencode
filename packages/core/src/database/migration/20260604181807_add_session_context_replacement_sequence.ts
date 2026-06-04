import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260604181807_add_session_context_replacement_sequence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` ADD \`replacement_seq\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
