CREATE TABLE `summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`turn` integer NOT NULL,
	`time` integer NOT NULL,
	`mode` text NOT NULL,
	`created_at` text NOT NULL
);
