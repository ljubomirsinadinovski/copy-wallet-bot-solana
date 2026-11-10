CREATE TABLE `copy_trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`signal_id` integer,
	`group_id` integer,
	`my_wallet_id` integer NOT NULL,
	`source_wallet_id` integer,
	`side` text NOT NULL,
	`mint` text NOT NULL,
	`paper` integer NOT NULL,
	`manual` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`skip_reason` text,
	`error` text,
	`pct` real,
	`sol_lamports` integer,
	`token_amount` text,
	`token_decimals` integer,
	`fee_lamports` integer,
	`realized_lamports` integer,
	`signature` text,
	`price_usd` real,
	`sol_usd` real,
	`market_cap_usd` real,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`confirmed_at` integer
);
--> statement-breakpoint
CREATE INDEX `trades_created_idx` ON `copy_trades` (`created_at`);--> statement-breakpoint
CREATE INDEX `trades_wallet_idx` ON `copy_trades` (`my_wallet_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `trades_signal_idx` ON `copy_trades` (`signal_id`);--> statement-breakpoint
CREATE TABLE `lots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`my_wallet_id` integer NOT NULL,
	`group_id` integer,
	`source_wallet_id` integer,
	`mint` text NOT NULL,
	`paper` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`token_amount` text NOT NULL,
	`token_decimals` integer NOT NULL,
	`cost_lamports` integer NOT NULL,
	`total_cost_lamports` integer NOT NULL,
	`proceeds_lamports` integer DEFAULT 0 NOT NULL,
	`realized_lamports` integer DEFAULT 0 NOT NULL,
	`bought_amount` text NOT NULL,
	`sold_amount` text DEFAULT '0' NOT NULL,
	`entry_mc_usd` real,
	`exit_mc_usd` real,
	`last_price_sol` real,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `lots_open_idx` ON `lots` (`status`,`my_wallet_id`,`mint`);--> statement-breakpoint
CREATE TABLE `my_wallets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`pubkey` text NOT NULL,
	`secret_cipher` text NOT NULL,
	`source` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `my_wallets_pubkey_unique` ON `my_wallets` (`pubkey`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`signature` text NOT NULL,
	`watched_wallet_id` integer,
	`address` text NOT NULL,
	`slot` integer NOT NULL,
	`block_time` integer,
	`detected_at` integer NOT NULL,
	`side` text NOT NULL,
	`mint` text NOT NULL,
	`token_decimals` integer NOT NULL,
	`token_amount` text NOT NULL,
	`pre_token_balance` text NOT NULL,
	`post_token_balance` text NOT NULL,
	`quote_mint` text,
	`quote_amount` text,
	`pre_quote_balance` text,
	`pct` real NOT NULL,
	`full_exit` integer DEFAULT false NOT NULL,
	`price_usd` real,
	`market_cap_usd` real,
	`source` text NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signals_unique` ON `signals` (`signature`,`address`,`mint`,`side`);--> statement-breakpoint
CREATE INDEX `signals_address_idx` ON `signals` (`address`,`detected_at`);--> statement-breakpoint
CREATE INDEX `signals_detected_idx` ON `signals` (`detected_at`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`mint` text PRIMARY KEY NOT NULL,
	`symbol` text,
	`name` text,
	`icon` text,
	`decimals` integer NOT NULL,
	`supply` text NOT NULL,
	`token_program` text NOT NULL,
	`freeze_authority` text,
	`mint_authority` text,
	`risky_extensions` text,
	`fetched_at` integer NOT NULL,
	`meta_fetched_at` integer
);
--> statement-breakpoint
CREATE TABLE `trader_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`my_wallet_id` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`paper` integer DEFAULT true NOT NULL,
	`paper_start_sol` real DEFAULT 1 NOT NULL,
	`multiplier` real DEFAULT 1 NOT NULL,
	`min_sol` real DEFAULT 0.01 NOT NULL,
	`max_sol` real DEFAULT 0.5 NOT NULL,
	`max_pct` real DEFAULT 25 NOT NULL,
	`max_sol_per_token` real DEFAULT 1 NOT NULL,
	`reserve_sol` real DEFAULT 0.02 NOT NULL,
	`slippage_bps` integer,
	`skip_if_holding` integer DEFAULT false NOT NULL,
	`max_open_positions` integer DEFAULT 10 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`my_wallet_id`) REFERENCES `my_wallets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trader_groups_my_wallet_id_unique` ON `trader_groups` (`my_wallet_id`);--> statement-breakpoint
CREATE TABLE `watched_wallets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`address` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'main' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`copy_buys` integer DEFAULT true NOT NULL,
	`copy_sells` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `trader_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watched_wallets_address_unique` ON `watched_wallets` (`address`);