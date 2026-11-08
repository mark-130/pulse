CREATE TABLE `race_meta` (
	`meta_key` text PRIMARY KEY NOT NULL,
	`priority` text,
	`type` text,
	`goal_override_s` real,
	`notes` text,
	`updated_at` text NOT NULL
);
