DROP INDEX IF EXISTS `event_aggregate_seq_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `event_aggregate_type_seq_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `session_message_session_seq_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `event_aggregate_seq_uidx` ON `event` (`aggregate_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_message_session_seq_uidx` ON `session_message` (`session_id`,`seq`);