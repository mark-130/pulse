CREATE TABLE `backfill_progress` (
	`kind` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`status` text NOT NULL,
	`rows` integer DEFAULT 0 NOT NULL,
	`reason` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`kind`, `window_start`)
);
--> statement-breakpoint
CREATE TABLE `daily_reading` (
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`value` real NOT NULL,
	`value2` real,
	`value3` real,
	PRIMARY KEY(`kind`, `date`)
);
