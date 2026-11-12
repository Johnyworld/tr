CREATE TABLE `retrievals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn` integer NOT NULL,
	`time` integer NOT NULL,
	`mode` text NOT NULL,
	`collection` text NOT NULL,
	`purpose` text NOT NULL,
	`trace` text NOT NULL,
	`created_at` text NOT NULL
);
