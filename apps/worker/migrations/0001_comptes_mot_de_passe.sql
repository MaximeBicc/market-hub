-- Passage de la cle d'acces unique a deux comptes nommes.
--
-- Motif : l'outil est utilise a deux. Une cle d'acces WebAuthn est liee a un
-- appareil, ce qui convient mal a un compte partage entre deux personnes sur
-- plusieurs machines. Un identifiant et un mot de passe par personne rendent
-- aussi les journaux lisibles : on sait qui a fait quoi.
--
-- Les mots de passe sont aleatoires sur 24 caracteres (~140 bits). Le hachage
-- est PBKDF2-HMAC-SHA256 a 100 000 iterations, plafond impose par Cloudflare.
-- Ce plafond est inferieur aux recommandations OWASP, mais celles-ci visent
-- les mots de passe choisis par un humain : face a un secret vraiment
-- aleatoire de cette longueur, le nombre d'iterations devient secondaire.
--
-- La table user est recreee plutot qu'alteree : SQLite n'accepte pas d'ajouter
-- des colonnes NOT NULL sans defaut, et il n'y avait aucune donnee a preserver.

DELETE FROM session;
DELETE FROM passkey;
DELETE FROM push_subscription;
DELETE FROM alert_rule;
DROP TABLE user;

CREATE TABLE `user` (
  `id` text PRIMARY KEY NOT NULL,
  `username` text NOT NULL UNIQUE,
  `display_name` text NOT NULL,
  `email` text,
  `password_hash` text NOT NULL,
  `password_salt` text NOT NULL,
  `password_iterations` integer NOT NULL,
  `password_changed_at` integer,
  `created_at` integer NOT NULL,
  `last_login_at` integer
);

-- Comparaison de l'identifiant sans tenir compte de la casse : personne ne
-- doit echouer a se connecter pour un « m » majuscule.
CREATE UNIQUE INDEX `user_username_idx` ON `user` (lower(`username`));

INSERT INTO `user` (id, username, display_name, email, password_hash, password_salt, password_iterations, created_at)
VALUES ('Rxsg3-htBOOm8e2iUlK0yg', 'GWD_Market-hub', 'GWD', NULL, 'Bv9RJruno40lFDU8OdEacfMKP51FJTIKUCsyAzA1e3g=', '8kUDnl7vDgymQw3Rl+U02Q==', 100000, 1787202332);

INSERT INTO `user` (id, username, display_name, email, password_hash, password_salt, password_iterations, created_at)
VALUES ('fCKLvBHLPI-GVCChvh5qlw', 'MXB_Market-hub', 'MXB', NULL, '3zcif6VV1/G4yafwVwCaXG3iSSgRZxkEQFcDyQQ+7zI=', 'BH6dekEywoXf8HsgH8nhoA==', 100000, 1787202332);

-- Regles d'alerte par defaut, pour chaque compte : chacun choisit ce qu'il
-- veut recevoir sur son propre telephone.
INSERT INTO `alert_rule` (id, user_id, name, kind, params, shop_id, enabled, cooldown_sec, last_fired_at) VALUES ('seed001xxxxxxxx', 'Rxsg3-htBOOm8e2iUlK0yg', 'Nouvelle commande', 'new_order', '{}', NULL, 1, 60, NULL);
INSERT INTO `alert_rule` (id, user_id, name, kind, params, shop_id, enabled, cooldown_sec, last_fired_at) VALUES ('seed002xxxxxxxx', 'Rxsg3-htBOOm8e2iUlK0yg', 'Commande > 200 EUR', 'big_order', '{"minAmount":20000}', NULL, 1, 300, NULL);
INSERT INTO `alert_rule` (id, user_id, name, kind, params, shop_id, enabled, cooldown_sec, last_fired_at) VALUES ('seed003xxxxxxxx', 'Rxsg3-htBOOm8e2iUlK0yg', 'Stock <= 3', 'low_stock', '{"quantity":3}', NULL, 1, 3600, NULL);
INSERT INTO `alert_rule` (id, user_id, name, kind, params, shop_id, enabled, cooldown_sec, last_fired_at) VALUES ('seed004xxxxxxxx', 'Rxsg3-htBOOm8e2iUlK0yg', 'Rupture de stock', 'sold_out', '{}', NULL, 1, 1800, NULL);
INSERT INTO `alert_rule` (id, user_id, name, kind, params, shop_id, enabled, cooldown_sec, last_fired_at) VALUES ('seed005xxxxxxxx', 'fCKLvBHLPI-GVCChvh5qlw', 'Nouvelle commande', 'new_order', '{}', NULL, 1, 60, NULL);
INSERT INTO `alert_rule` (id, user_id, name, kind, params, shop_id, enabled, cooldown_sec, last_fired_at) VALUES ('seed006xxxxxxxx', 'fCKLvBHLPI-GVCChvh5qlw', 'Commande > 200 EUR', 'big_order', '{"minAmount":20000}', NULL, 1, 300, NULL);
INSERT INTO `alert_rule` (id, user_id, name, kind, params, shop_id, enabled, cooldown_sec, last_fired_at) VALUES ('seed007xxxxxxxx', 'fCKLvBHLPI-GVCChvh5qlw', 'Stock <= 3', 'low_stock', '{"quantity":3}', NULL, 1, 3600, NULL);
INSERT INTO `alert_rule` (id, user_id, name, kind, params, shop_id, enabled, cooldown_sec, last_fired_at) VALUES ('seed008xxxxxxxx', 'fCKLvBHLPI-GVCChvh5qlw', 'Rupture de stock', 'sold_out', '{}', NULL, 1, 1800, NULL);
