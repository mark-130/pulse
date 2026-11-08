CREATE TABLE `ai_text` (
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`text` text NOT NULL,
	`data` text,
	`model` text NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`kind`, `key`)
);
