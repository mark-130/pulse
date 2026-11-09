CREATE TABLE `ai_reservation` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`feature` text NOT NULL,
	`model` text NOT NULL,
	`estimate_gbp` real NOT NULL
);
