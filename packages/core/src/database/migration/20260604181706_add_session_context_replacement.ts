import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260604181706_add_session_context_replacement",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` ADD \`replacement_pending\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
