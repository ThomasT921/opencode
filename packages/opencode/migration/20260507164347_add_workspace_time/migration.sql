-- Add workspace.time_used. The original migration was
--     ALTER TABLE `workspace` ADD `time_used` integer NOT NULL;
-- which fails on bun:sqlite for any user with existing workspace rows because
-- SQLite refuses to add a NOT NULL column without a default to a non-empty
-- table. Replaced with a table-recreate pattern that is safe regardless of
-- whether the column already exists (e.g. user successfully ran the original
-- migration on an empty workspace table) or doesn't (e.g. user upgrading from
-- v1.14.41 with populated workspace rows hit the original failure).

CREATE TABLE `__new_workspace` (
  `id` text PRIMARY KEY NOT NULL,
  `type` text NOT NULL,
  `name` text DEFAULT '' NOT NULL,
  `branch` text,
  `directory` text,
  `extra` text,
  `project_id` text NOT NULL,
  `time_used` integer DEFAULT 0 NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_workspace` (`id`, `type`, `name`, `branch`, `directory`, `extra`, `project_id`)
  SELECT `id`, `type`, `name`, `branch`, `directory`, `extra`, `project_id` FROM `workspace`;
--> statement-breakpoint
DROP TABLE `workspace`;
--> statement-breakpoint
ALTER TABLE `__new_workspace` RENAME TO `workspace`;
