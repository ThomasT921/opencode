CREATE TABLE `session_context_message` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`parts` text NOT NULL,
	CONSTRAINT `session_context_message_pk` PRIMARY KEY(`session_id`, `seq`),
	CONSTRAINT `fk_session_context_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `session_context_epoch` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `session_context_message_session_seq_idx` ON `session_context_message` (`session_id`,`seq`);