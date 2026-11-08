-- Sending time is sold through Alipay, not USDT-TRC20. An order is now identified
-- by its own `out_trade_no` at the cashier, so it no longer needs an amount
-- checksum or a receiving address.
--
-- `usdt_orders` is dropped rather than kept: an order could only be opened when
-- the deployment had `USDT_PAYMENT_ADDRESS` set, and a deployment that never had
-- one never wrote a row. Nothing in it can be credited in yuan anyway.
DROP TABLE IF EXISTS `usdt_orders`;
--> statement-breakpoint
CREATE TABLE `alipay_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`months` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`trade_no` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`paid_at` integer,
	`paid_until` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alipay_orders_trade_idx` ON `alipay_orders` (`trade_no`);
--> statement-breakpoint
CREATE INDEX `alipay_orders_user_idx` ON `alipay_orders` (`user_id`);
--> statement-breakpoint
CREATE INDEX `alipay_orders_status_idx` ON `alipay_orders` (`status`,`expires_at`);
