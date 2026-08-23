-- ═══════════════════════════════════════════════════════════════════════
--  LES VARIANTES
-- ═══════════════════════════════════════════════════════════════════════
--
-- Le modèle était plat : un produit, un SKU, un prix, un stock. Or un
-- « support téléphone ventouse » existe en dix-sept coloris, chacun avec son
-- stock. Shopify en envoyait donc dix-sept annonces sans lien entre elles, et
-- vingt-six des vingt-huit lignes n'avaient AUCUN produit maître — parce que
-- le rapprochement se fait par SKU et que Shopify n'en impose pas.
--
-- La conséquence n'était pas cosmétique : une vente sur l'une de ces
-- vingt-six lignes ne décrémentait rien. Le service de ventes retrouvait
-- l'annonce, lisait son produit maître, trouvait NULL, et abandonnait la
-- ligne en la comptant « non rattachée ».
--
-- CE QUE CETTE MIGRATION NE DEMANDE À PERSONNE : aucun appel réseau, aucune
-- ressaisie. L'identifiant du produit parent Shopify dort déjà dans
-- `listing.marketplace_data` depuis le premier import — il n'avait jamais
-- été lu. C'est lui qui recolle les vingt-huit lignes en six produits.

-- ── 1. La variante : l'unité réellement vendable ──────────────────────
CREATE TABLE variant (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES product(id),
  -- NULLABLE, et c'est le fait central : vingt-six variantes n'en ont pas,
  -- Shopify n'en exige pas, et n'impose même pas qu'il soit unique.
  sku              TEXT,
  -- Identité de repli quand le SKU manque : « couleur=violet ». Normalisée.
  option_key       TEXT NOT NULL DEFAULT '',
  option_values    TEXT NOT NULL DEFAULT '[]',
  price_amount     INTEGER NOT NULL DEFAULT 0,
  price_currency   TEXT NOT NULL DEFAULT 'EUR',
  barcode          TEXT,
  weight_grams     INTEGER,
  image_url        TEXT,
  position         INTEGER NOT NULL DEFAULT 0,
  -- « archived » : la plateforme ne renvoie plus cette variante. On ne
  -- supprime pas la ligne — son historique de ventes y pend — mais son stock
  -- cesse d'être compté. Sans cet état, un coloris retiré chez Shopify reste
  -- comptabilisé ici pour toujours.
  status           TEXT NOT NULL DEFAULT 'active',
  marketplace_data TEXT NOT NULL DEFAULT '{}',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE UNIQUE INDEX variant_product_optkey_idx ON variant(product_id, option_key);
CREATE INDEX variant_product_idx ON variant(product_id);

-- Index PARTIEL : le SKU est unique quand il existe, parce qu'une ligne de
-- commande n'apporte souvent que lui — un SKU ambigu deviendrait une
-- décrémentation au hasard. Mais NULL est autorisé autant de fois qu'il faut.
CREATE UNIQUE INDEX variant_sku_idx ON variant(sku) WHERE sku IS NOT NULL;

-- ── 2. Le produit gagne ses axes de variation ─────────────────────────
-- `product.price_amount` survit et devient le prix HÉRITÉ par une variante
-- nouvellement créée ; `product.stock` devient une somme, plus jamais
-- autoritaire. Les deux restent lus par le panel d'IA, d'où leur maintien.
ALTER TABLE product ADD COLUMN options TEXT NOT NULL DEFAULT '[]';
ALTER TABLE product ADD COLUMN variant_count INTEGER NOT NULL DEFAULT 1;

-- ── 3. Une variante unique pour chaque produit existant ───────────────
INSERT INTO variant (id, product_id, sku, option_key, option_values,
                     price_amount, price_currency, position, status,
                     marketplace_data, created_at, updated_at)
SELECT 'var_' || lower(hex(randomblob(12))), p.id, p.sku, '', '[]',
       p.price_amount, p.price_currency, 0, 'active', '{}',
       p.created_at, p.updated_at
FROM product p;

-- ── 4. Le groupe d'annonces : l'objet PARENT chez la plateforme ───────
-- Un produit Shopify, un inventory_item_group eBay, un listing Etsy. Il
-- existe parce que le statut, l'URL et la catégorie y vivent — pas sur la
-- variante. Chez Etsy c'est structurant : une annonce a UN état, et
-- « désactiver le coloris violet » n'existe pas.
CREATE TABLE listing_group (
  id               TEXT PRIMARY KEY,
  shop_id          TEXT NOT NULL REFERENCES shop(id),
  product_id       TEXT REFERENCES product(id),
  remote_group_id  TEXT NOT NULL,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL,
  url              TEXT,
  image_url        TEXT,
  published_axes   TEXT NOT NULL DEFAULT '[]',
  marketplace_data TEXT NOT NULL DEFAULT '{}',
  synced_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX listing_group_shop_remote_idx ON listing_group(shop_id, remote_group_id);
CREATE INDEX listing_group_product_idx ON listing_group(product_id);

-- ── 5. L'annonce pointe vers la variante et vers le groupe ────────────
ALTER TABLE listing ADD COLUMN variant_id TEXT REFERENCES variant(id);
ALTER TABLE listing ADD COLUMN group_id TEXT REFERENCES listing_group(id);
ALTER TABLE listing ADD COLUMN option_values TEXT;
CREATE INDEX listing_variant_idx ON listing(variant_id);
CREATE INDEX listing_group_idx ON listing(group_id);

-- ── 6. Rattacher les annonces déjà rapprochées à leur variante ────────
UPDATE listing SET variant_id = (
    SELECT v.id FROM variant v WHERE v.product_id = listing.product_id
  )
WHERE product_id IS NOT NULL
  AND (SELECT COUNT(*) FROM variant v WHERE v.product_id = listing.product_id) = 1;

-- ── 7. Reconstituer les groupes depuis ce que Shopify a déjà écrit ────
-- Ici les vingt-huit lignes redeviennent six objets, sans un seul appel
-- réseau. Le produit maître n'est adopté que s'il est SANS AMBIGUÏTÉ : un
-- seul produit distinct dans le groupe. Zéro ou plusieurs → NULL, et un
-- humain tranchera plutôt qu'une règle devine.
INSERT INTO listing_group (id, shop_id, product_id, remote_group_id, title,
                           status, url, image_url, published_axes,
                           marketplace_data, synced_at)
SELECT 'lg_' || lower(hex(randomblob(12))),
       l.shop_id,
       CASE WHEN COUNT(DISTINCT l.product_id) = 1 THEN MIN(l.product_id) END,
       json_extract(l.marketplace_data, '$.productId'),
       MIN(l.title),
       CASE WHEN MAX(l.status = 'active') = 1 THEN 'active' ELSE 'draft' END,
       MIN(l.url), MIN(l.image_url), '[]', '{}', MAX(l.synced_at)
FROM listing l
WHERE json_extract(l.marketplace_data, '$.productId') IS NOT NULL
GROUP BY l.shop_id, json_extract(l.marketplace_data, '$.productId');

UPDATE listing SET group_id = (
    SELECT g.id FROM listing_group g
    WHERE g.shop_id = listing.shop_id
      AND g.remote_group_id = json_extract(listing.marketplace_data, '$.productId')
  )
WHERE json_extract(marketplace_data, '$.productId') IS NOT NULL;

-- ── 8. Le stock se compte par VARIANTE ────────────────────────────────
-- Il n'y a pas d'alternative défendable : deux coloris du même produit ont
-- des quantités indépendantes, et tout l'objet de l'outil est de refléter
-- ce nombre. Une somme au niveau du produit ne se repousse pas — « mettre le
-- stock à 12 » n'a aucun sens pour un parent à dix-sept coloris.
--
-- La VERSION est reportée, jamais réinitialisée : le rapprochement de stock
-- compare la version centrale à celle mémorisée sur l'annonce. La remettre à
-- 1 ferait passer un stock qui a bougé pour un stock intact.
CREATE TABLE inventory_new (
  variant_id TEXT PRIMARY KEY REFERENCES variant(id),
  on_hand    INTEGER NOT NULL DEFAULT 0,
  reserved   INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

INSERT INTO inventory_new (variant_id, on_hand, reserved, version, updated_at)
SELECT v.id, i.on_hand, i.reserved, i.version, i.updated_at
FROM inventory i
JOIN variant v ON v.product_id = i.product_id;

DROP TABLE inventory;
ALTER TABLE inventory_new RENAME TO inventory;
