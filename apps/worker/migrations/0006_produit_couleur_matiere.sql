-- Migration 0006 : Ajout de la couleur et de la matière aux fiches produits
ALTER TABLE `product` ADD `color` text;
ALTER TABLE `product` ADD `material` text;
