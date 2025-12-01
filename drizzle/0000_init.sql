CREATE TABLE `subscribers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`verify_token` text,
	`unsubscribe_token` text NOT NULL
);

CREATE UNIQUE INDEX `subscribers_email_unique` ON `subscribers` (`email`);


