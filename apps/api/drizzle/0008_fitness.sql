CREATE TABLE `personal_record` (
	`type_id` integer PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`record_type` text NOT NULL,
	`value` text NOT NULL,
	`raw_value` real,
	`date` text NOT NULL,
	`first_seen` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `race_prediction` (
	`date` text PRIMARY KEY NOT NULL,
	`seconds` text NOT NULL,
	`garmin_date` text,
	`fetched_at` text NOT NULL
);
