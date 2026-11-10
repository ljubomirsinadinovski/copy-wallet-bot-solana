ALTER TABLE `trader_groups` ADD `sizing_mode` text DEFAULT 'size' NOT NULL;--> statement-breakpoint
ALTER TABLE `trader_groups` ADD `copy_pct` real DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `trader_groups` ADD `min_usd` real DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `trader_groups` ADD `max_usd_per_token` real DEFAULT 50 NOT NULL;