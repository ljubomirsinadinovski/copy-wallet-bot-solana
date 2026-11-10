ALTER TABLE `tokens` ADD `transfer_fee_bps` integer;--> statement-breakpoint
UPDATE `tokens` SET `risky_extensions` = NULL, `fetched_at` = 0 WHERE `risky_extensions` LIKE '%transfer fee%';
