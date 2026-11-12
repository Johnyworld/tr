CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`seq` integer PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transcript` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn` integer NOT NULL,
	`entry` text NOT NULL,
	`created_at` text NOT NULL
);
