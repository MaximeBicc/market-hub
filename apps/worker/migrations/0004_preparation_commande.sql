-- Préparation et exécution de commande : consommables et suivi d'expédition
--

ALTER TABLE `order` ADD `shipping_carrier` text;
--> statement-breakpoint
ALTER TABLE `order` ADD `tracking_number` text;
--> statement-breakpoint
ALTER TABLE `order` ADD `tracking_url` text;
--> statement-breakpoint
ALTER TABLE `order` ADD `shipped_at` integer;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `consumable` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `category` text NOT NULL,
  `stock` integer DEFAULT 0 NOT NULL,
  `min_alert` integer DEFAULT 5 NOT NULL,
  `unit_cost` integer DEFAULT 0,
  `image_url` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `order_consumable` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL REFERENCES `order`(`id`),
  `consumable_id` text NOT NULL REFERENCES `consumable`(`id`),
  `quantity` integer DEFAULT 1 NOT NULL,
  `used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `order_consumable_order_idx` ON `order_consumable` (`order_id`);
