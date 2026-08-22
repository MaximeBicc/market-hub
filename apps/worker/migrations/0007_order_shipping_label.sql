-- Migration 0007 : Ajout des informations d'étiquette d'expédition sur les commandes
ALTER TABLE `order` ADD `shipping_label_url` text;
ALTER TABLE `order` ADD `shipping_label_type` text;
