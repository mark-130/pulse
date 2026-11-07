CREATE TABLE `activity` (
	`garmin_activity_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`start_local` text NOT NULL,
	`date` text NOT NULL,
	`distance_m` real,
	`duration_s` real,
	`avg_hr` integer,
	`max_hr` integer,
	`calories` integer,
	`elevation_gain_m` real,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `race` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_key` text NOT NULL,
	`event_uuid` text,
	`title` text NOT NULL,
	`date` text NOT NULL,
	`start_time_local` text,
	`time_zone` text,
	`distance_m` real,
	`goal_time_seconds` real,
	`is_race` integer NOT NULL,
	`primary_event` integer NOT NULL,
	`subscribed` integer NOT NULL,
	`location` text,
	`url` text,
	`active` integer DEFAULT true NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `race_event_key_unique` ON `race` (`event_key`);--> statement-breakpoint
DROP INDEX `garmin_snapshot_kind_date`;--> statement-breakpoint
CREATE UNIQUE INDEX `garmin_snapshot_kind_date` ON `garmin_snapshot` (`kind`,`date`);--> statement-breakpoint
ALTER TABLE `sync_state` ADD `last_attempt` text;--> statement-breakpoint
ALTER TABLE `sync_state` ADD `last_alert_at` text;--> statement-breakpoint
ALTER TABLE `sync_state` ADD `detail` text;