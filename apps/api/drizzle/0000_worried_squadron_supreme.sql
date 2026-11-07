CREATE TABLE `ai_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`feature` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_gbp` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`payload_hash` text NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `briefing` (
	`date` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`data` text,
	`model` text,
	`tokens` integer
);
--> statement-breakpoint
CREATE TABLE `chat_message` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_calls` text
);
--> statement-breakpoint
CREATE TABLE `garmin_snapshot` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `garmin_snapshot_kind_date` ON `garmin_snapshot` (`kind`,`date`);--> statement-breakpoint
CREATE TABLE `proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_system` text NOT NULL,
	`payload` text NOT NULL,
	`before` text,
	`after` text,
	`rationale` text,
	`created_by` text NOT NULL,
	`state_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`decided_at` text,
	`result` text
);
--> statement-breakpoint
CREATE TABLE `race` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`google_event_id` text NOT NULL,
	`garmin_match` text,
	`title` text NOT NULL,
	`date` text NOT NULL,
	`start_time` text,
	`distance_km` real,
	`priority` text,
	`goal_s` integer,
	`type` text,
	`inferred_fields` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `race_google_event_id_unique` ON `race` (`google_event_id`);--> statement-breakpoint
CREATE TABLE `secret` (
	`name` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`job` text PRIMARY KEY NOT NULL,
	`last_ok` text,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workout` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`garmin_scheduled_id` text NOT NULL,
	`garmin_workout_id` text,
	`date` text NOT NULL,
	`name` text NOT NULL,
	`sport` text,
	`duration_s` integer,
	`completed` integer DEFAULT false NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workout_garmin_scheduled_id_unique` ON `workout` (`garmin_scheduled_id`);