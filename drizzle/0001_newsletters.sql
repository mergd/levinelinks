CREATE TABLE `newsletters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`subject` text NOT NULL,
	`link_count` integer DEFAULT 0,
	`summary_count` integer DEFAULT 0,
	`archive_count` integer DEFAULT 0,
	`processed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `newsletters_date_unique` ON `newsletters` (`date`);







