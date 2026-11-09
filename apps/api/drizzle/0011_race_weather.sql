CREATE TABLE `race_forecast` (
	`race_key` text PRIMARY KEY NOT NULL,
	`fetched_at` text,
	`last_attempt` text NOT NULL,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`time_zone` text,
	`hours` text
);
--> statement-breakpoint
CREATE TABLE `race_place` (
	`race_key` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`query` text NOT NULL,
	`status` text NOT NULL,
	`name` text,
	`latitude` real,
	`longitude` real,
	`last_attempt` text NOT NULL,
	`last_error` text
);
--> statement-breakpoint
ALTER TABLE `race_meta` ADD `forecast_place` text;--> statement-breakpoint
ALTER TABLE `race_meta` ADD `forecast_name` text;--> statement-breakpoint
ALTER TABLE `race_meta` ADD `forecast_lat` real;--> statement-breakpoint
ALTER TABLE `race_meta` ADD `forecast_lon` real;