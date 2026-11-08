CREATE TABLE `hr_zones_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`first_seen` text NOT NULL,
	`profile` text NOT NULL,
	`method` text NOT NULL,
	`floors` text NOT NULL,
	`max_hr` integer NOT NULL,
	`resting_hr` integer,
	`lactate_threshold_hr` integer
);
--> statement-breakpoint
CREATE TABLE `kotcha_zone` (
	`zone` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`top_bpm` integer NOT NULL,
	`source` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vo2max_point` (
	`date` text PRIMARY KEY NOT NULL,
	`value` real NOT NULL,
	`carried_forward` integer DEFAULT false NOT NULL,
	`fetched_at` text NOT NULL
);
