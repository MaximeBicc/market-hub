-- Socle du moteur multi-marketplace.
--
-- On ETEND le schema existant plutot que de creer des tables paralleles :
-- deux sources de verite pour « une boutique » ou « une annonce »
-- divergeraient au premier oubli de mise a jour.
--
-- Correspondances avec le modele canonique du moteur :
--   MarketplaceAccount  -> table `shop`     (marketplace = platform)
--   Product             -> table `product`
--   Listing             -> table `listing`  (remoteId = external_id)
--   InventoryItem       -> table `inventory`     (nouvelle)
--   SalesEvent          -> table `sales_event`   (nouvelle)
--   Credentials         -> table `oauth_token`   (deja chiffree AES-GCM)

-- --------------------------------------------------------------------
-- Comptes : un identifiant lisible, et plusieurs comptes par plateforme
-- --------------------------------------------------------------------
-- `slug` sert dans les journaux et l'interface (« ebay_electronique ») ;
-- `id` reste immuable et ne doit jamais servir d'affichage.
ALTER TABLE `shop` ADD COLUMN `slug` text;

UPDATE `shop` SET `slug` = `platform` || '_' || lower(replace(`display_name`, ' ', '_'))
WHERE `slug` IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS `shop_slug_idx` ON `shop` (`slug`);

-- --------------------------------------------------------------------
-- Produit maitre : prix et stock de reference
-- --------------------------------------------------------------------
-- Le produit portait un prix d'achat mais aucun prix de vente ni stock de
-- reference : impossible de publier une annonce a partir de lui.
ALTER TABLE `product` ADD COLUMN `price_amount` integer NOT NULL DEFAULT 0;
ALTER TABLE `product` ADD COLUMN `price_currency` text NOT NULL DEFAULT 'EUR';
ALTER TABLE `product` ADD COLUMN `stock` integer NOT NULL DEFAULT 0;
ALTER TABLE `product` ADD COLUMN `images` text;
ALTER TABLE `product` ADD COLUMN `tags` text;
-- Champs propres a une plateforme : categorie eBay, taxonomie Etsy, etc.
ALTER TABLE `product` ADD COLUMN `marketplace_data` text;

-- --------------------------------------------------------------------
-- Annonces : donnees specifiques a la plateforme
-- --------------------------------------------------------------------
ALTER TABLE `listing` ADD COLUMN `marketplace_data` text;

-- --------------------------------------------------------------------
-- Stock central
-- --------------------------------------------------------------------
-- `reserved` couvre le laps entre vente constatee et expedition : la
-- marchandise est encore la, mais n'est plus vendable.
-- `version` porte le verrouillage optimiste : deux ventes simultanees sur
-- deux plateformes ne doivent pas se perdre l'une l'autre.
CREATE TABLE IF NOT EXISTS `inventory` (
  `product_id` text PRIMARY KEY NOT NULL REFERENCES `product`(`id`),
  `on_hand` integer NOT NULL DEFAULT 0,
  `reserved` integer NOT NULL DEFAULT 0,
  `version` integer NOT NULL DEFAULT 1,
  `updated_at` integer NOT NULL
);

-- --------------------------------------------------------------------
-- Deduplication des ventes entrantes
-- --------------------------------------------------------------------
-- Les plateformes garantissent « au moins une fois », jamais « exactement
-- une fois ». Sans cette table, une meme vente livree deux fois
-- decrementerait le stock deux fois.
CREATE TABLE IF NOT EXISTS `sales_event` (
  `id` text PRIMARY KEY NOT NULL,          -- hash(account_id + event_id)
  `account_id` text NOT NULL,
  `event_id` text NOT NULL,
  `marketplace` text NOT NULL,
  `remote_order_id` text NOT NULL,
  `kind` text NOT NULL,                    -- paid | cancelled | returned
  `occurred_at` text NOT NULL,
  `received_at` integer NOT NULL,
  `unmatched_lines` integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS `sales_event_account_evt_idx`
  ON `sales_event` (`account_id`, `event_id`);
CREATE INDEX IF NOT EXISTS `sales_event_received_idx`
  ON `sales_event` (`received_at`);

-- --------------------------------------------------------------------
-- Journal des commandes de l'orchestrateur
-- --------------------------------------------------------------------
-- Sans trace, une commande partie vers cinq plateformes devient
-- indebogable : on ne sait plus laquelle a reussi, laquelle demande une
-- action manuelle, laquelle a echoue et pourquoi.
CREATE TABLE IF NOT EXISTS `command_log` (
  `id` text PRIMARY KEY NOT NULL,
  `idempotency_key` text NOT NULL,
  `command` text NOT NULL,                 -- createListing | setPrice | setStock | setActive
  `product_id` text,
  `account_id` text NOT NULL,
  `marketplace` text NOT NULL,
  `status` text NOT NULL,                  -- success | pending_remote | manual_required | unsupported | failed
  `message` text,
  `remote_id` text,
  `at` integer NOT NULL
);

CREATE INDEX IF NOT EXISTS `command_log_at_idx` ON `command_log` (`at`);
CREATE INDEX IF NOT EXISTS `command_log_key_idx` ON `command_log` (`idempotency_key`);
