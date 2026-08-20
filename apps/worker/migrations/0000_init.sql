-- Migration initiale.
--
-- Ce fichier est fourni pour que `wrangler d1 migrations apply` fonctionne dès
-- le premier déploiement. Par la suite, ne l'éditez plus : lancez
-- `pnpm db:generate` après chaque modification de src/db/schema.ts, ce qui
-- produit une NOUVELLE migration. Modifier une migration déjà appliquée
-- désynchronise la base locale et la base de production.

CREATE TABLE `user` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL UNIQUE,
  `created_at` integer NOT NULL
);

CREATE TABLE `passkey` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `user`(`id`),
  `public_key` text NOT NULL,
  `counter` integer DEFAULT 0 NOT NULL,
  `transports` text,
  `label` text,
  `created_at` integer NOT NULL,
  `last_used_at` integer
);
CREATE INDEX `passkey_user_idx` ON `passkey` (`user_id`);

CREATE TABLE `session` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `user`(`id`),
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL
);
CREATE INDEX `session_expires_idx` ON `session` (`expires_at`);

CREATE TABLE `shop` (
  `id` text PRIMARY KEY NOT NULL,
  `platform` text NOT NULL,
  `external_id` text NOT NULL,
  `display_name` text NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `config` text DEFAULT '{}' NOT NULL,
  `connected_at` integer NOT NULL
);
CREATE UNIQUE INDEX `shop_platform_ext_idx` ON `shop` (`platform`,`external_id`);

CREATE TABLE `oauth_token` (
  `shop_id` text PRIMARY KEY NOT NULL REFERENCES `shop`(`id`),
  `ciphertext` text NOT NULL,
  `key_version` integer DEFAULT 1 NOT NULL,
  `access_expires_at` integer,
  `refresh_expires_at` integer,
  `updated_at` integer NOT NULL
);
CREATE INDEX `token_access_exp_idx` ON `oauth_token` (`access_expires_at`);

CREATE TABLE `product` (
  `id` text PRIMARY KEY NOT NULL,
  `sku` text NOT NULL UNIQUE,
  `title` text NOT NULL,
  `description` text,
  `cost_price` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE INDEX `product_sku_idx` ON `product` (`sku`);

CREATE TABLE `listing` (
  `id` text PRIMARY KEY NOT NULL,
  `shop_id` text NOT NULL REFERENCES `shop`(`id`),
  `product_id` text REFERENCES `product`(`id`),
  `external_id` text NOT NULL,
  `sku` text,
  `title` text NOT NULL,
  `price_amount` integer NOT NULL,
  `price_currency` text NOT NULL,
  `quantity` integer DEFAULT 0 NOT NULL,
  `status` text NOT NULL,
  `url` text,
  `image_url` text,
  `content_hash` text NOT NULL,
  `synced_at` integer NOT NULL
);
CREATE UNIQUE INDEX `listing_shop_ext_idx` ON `listing` (`shop_id`,`external_id`);
CREATE INDEX `listing_sku_idx` ON `listing` (`sku`);
CREATE INDEX `listing_product_idx` ON `listing` (`product_id`);

CREATE TABLE `order` (
  `id` text PRIMARY KEY NOT NULL,
  `shop_id` text NOT NULL REFERENCES `shop`(`id`),
  `external_id` text NOT NULL,
  `status` text NOT NULL,
  `total_amount` integer NOT NULL,
  `total_currency` text NOT NULL,
  `buyer_name` text,
  `placed_at` integer NOT NULL,
  `content_hash` text NOT NULL,
  `synced_at` integer NOT NULL
);
CREATE UNIQUE INDEX `order_shop_ext_idx` ON `order` (`shop_id`,`external_id`);
CREATE INDEX `order_placed_idx` ON `order` (`placed_at`);
CREATE INDEX `order_status_idx` ON `order` (`status`);

CREATE TABLE `order_line` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL REFERENCES `order`(`id`),
  `sku` text,
  `listing_external_id` text,
  `title` text NOT NULL,
  `quantity` integer NOT NULL,
  `unit_price_amount` integer NOT NULL,
  `unit_price_currency` text NOT NULL
);
CREATE INDEX `order_line_order_idx` ON `order_line` (`order_id`);

CREATE TABLE `sync_job` (
  `id` text PRIMARY KEY NOT NULL,
  `shop_id` text NOT NULL REFERENCES `shop`(`id`),
  `resource` text NOT NULL,
  `interval_sec` integer DEFAULT 600 NOT NULL,
  `next_run_at` integer NOT NULL,
  `last_run_at` integer,
  `last_ok_at` integer,
  `cursor` text,
  `failure_count` integer DEFAULT 0 NOT NULL,
  `last_error` text,
  `enabled` integer DEFAULT 1 NOT NULL
);
CREATE UNIQUE INDEX `sync_job_shop_res_idx` ON `sync_job` (`shop_id`,`resource`);
CREATE INDEX `sync_job_due_idx` ON `sync_job` (`enabled`,`next_run_at`);

CREATE TABLE `webhook_receipt` (
  `id` text PRIMARY KEY NOT NULL,
  `shop_id` text NOT NULL,
  `topic` text NOT NULL,
  `received_at` integer NOT NULL
);
CREATE INDEX `webhook_received_idx` ON `webhook_receipt` (`received_at`);

CREATE TABLE `event_log` (
  `id` text PRIMARY KEY NOT NULL,
  `at` integer NOT NULL,
  `level` text NOT NULL,
  `scope` text NOT NULL,
  `shop_id` text,
  `message` text NOT NULL,
  `data` text
);
CREATE INDEX `event_at_idx` ON `event_log` (`at`);
CREATE INDEX `event_level_idx` ON `event_log` (`level`);

CREATE TABLE `push_subscription` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `user`(`id`),
  `endpoint` text NOT NULL UNIQUE,
  `p256dh` text NOT NULL,
  `auth` text NOT NULL,
  `user_agent` text,
  `created_at` integer NOT NULL,
  `failed_at` integer
);
CREATE INDEX `push_user_idx` ON `push_subscription` (`user_id`);

CREATE TABLE `alert_rule` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `user`(`id`),
  `name` text NOT NULL,
  `kind` text NOT NULL,
  `params` text DEFAULT '{}' NOT NULL,
  `shop_id` text,
  `enabled` integer DEFAULT 1 NOT NULL,
  `cooldown_sec` integer DEFAULT 3600 NOT NULL,
  `last_fired_at` integer
);
