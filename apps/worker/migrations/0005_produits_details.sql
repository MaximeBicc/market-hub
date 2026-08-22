-- Détails du catalogue maître (emplacement, poids, seuil d'alerte, emballage par défaut)
--

ALTER TABLE `product` ADD `min_alert` integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE `product` ADD `location` text;
--> statement-breakpoint
ALTER TABLE `product` ADD `weight_grams` integer;
--> statement-breakpoint
ALTER TABLE `product` ADD `default_consumable_id` text;
