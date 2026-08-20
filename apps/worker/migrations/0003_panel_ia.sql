-- Panel d'IA : consommation, cache, journal des analyses.
--
-- POURQUOI LE CACHE EST ICI ET NON DANS KV, qui semblerait pourtant fait
-- pour ca : l'offre gratuite KV plafonne a 1 000 ECRITURES par jour, et ce
-- quota est deja partage avec le reste de l'application. Chaque execution de
-- skill ecrit une entree ; le cache aurait donc consomme a lui seul tout le
-- budget KV avant midi, et fait tomber le reste de l'app avec lui.
-- D1 autorise 100 000 ecritures par jour. Le choix n'est pas une preference
-- de style, c'est la seule option qui tient dans le gratuit.
--
-- Toutes les dates sont des entiers en SECONDES depuis l'epoque, comme le
-- reste du schema. Sauf `day` et `observed_at`, en texte : le premier parce
-- qu'il doit correspondre exactement a la journee UTC que Cloudflare remet a
-- zero, le second parce qu'il vient d'une source externe qui l'a datee.

-- --------------------------------------------------------------------
-- Consommation quotidienne : le compteur qui garantit le zero euro
-- --------------------------------------------------------------------
-- `neurons` est la colonne importante, et c'est celle qui manquait au module
-- d'origine. Cloudflare offre 10 000 neurones par jour ; sans ce compteur on
-- ne sait ni combien il en reste, ni qu'une comparaison d'images en coute dix
-- fois plus qu'une classification. Le routeur s'en sert pour choisir un
-- modele plus econome a mesure que la journee avance.
CREATE TABLE IF NOT EXISTS `ai_usage` (
  `day` text NOT NULL,
  `provider` text NOT NULL,
  `model` text NOT NULL,
  `requests` integer DEFAULT 0 NOT NULL,
  `input_tokens` integer DEFAULT 0 NOT NULL,
  `output_tokens` integer DEFAULT 0 NOT NULL,
  -- REAL et non INTEGER : Workers AI facture des fractions de neurone
  -- (7,0213 pour une classification). Arrondir chaque appel introduirait un
  -- ecart d'un demi-neurone par appel, soit 1,5 % du budget sur une journee
  -- chargee — dans le mauvais sens, celui qui fait croire qu'il reste de la
  -- marge alors qu'il n'y en a plus.
  `neurons` real DEFAULT 0 NOT NULL,
  `search_requests` integer DEFAULT 0 NOT NULL,
  PRIMARY KEY (`day`, `provider`, `model`)
);

-- --------------------------------------------------------------------
-- Cache des resultats
-- --------------------------------------------------------------------
-- La cle porte le nom ET la version de la skill : corriger une skill doit
-- invalider ses anciennes reponses, sinon la correction reste invisible
-- pendant toute la duree de vie du cache.
CREATE TABLE IF NOT EXISTS `ai_cache` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `expires_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `ai_cache_expires_idx` ON `ai_cache` (`expires_at`);

-- --------------------------------------------------------------------
-- Journal des executions
-- --------------------------------------------------------------------
-- Une ligne par analyse reellement calculee. Les reponses servies depuis le
-- cache n'en creent pas : elles n'ont rien execute.
CREATE TABLE IF NOT EXISTS `ai_run` (
  `id` text PRIMARY KEY NOT NULL,
  `skill` text NOT NULL,
  `skill_version` text NOT NULL,
  `status` text NOT NULL,
  `data_class` text NOT NULL,
  `impact` text NOT NULL,
  `automatic` integer DEFAULT 0 NOT NULL,
  `input_hash` text NOT NULL,
  `provider` text,
  `model` text,
  `confidence` real,
  `neurons` real DEFAULT 0 NOT NULL,
  `source_count` integer DEFAULT 0 NOT NULL,
  `error` text,
  `started_at` integer NOT NULL,
  `finished_at` integer
);
CREATE INDEX IF NOT EXISTS `ai_run_started_idx` ON `ai_run` (`started_at`);
CREATE INDEX IF NOT EXISTS `ai_run_skill_idx` ON `ai_run` (`skill`, `started_at`);

-- --------------------------------------------------------------------
-- Preuves : d'ou vient un prix affiche a l'utilisateur
-- --------------------------------------------------------------------
-- Vide tant que la recherche marche n'est pas activee (elle demande une cle
-- Gemini). La table existe des maintenant parce que la regle qu'elle fait
-- respecter, elle, est deja en vigueur : aucun prix de marche ne s'affiche
-- sans URL ni date d'observation.
CREATE TABLE IF NOT EXISTS `ai_evidence` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL REFERENCES `ai_run`(`id`),
  `url` text NOT NULL,
  `title` text,
  `kind` text NOT NULL,
  `observed_at` text NOT NULL,
  `snippet` text,
  `price` integer,
  `currency` text,
  `reliability` real
);
CREATE INDEX IF NOT EXISTS `ai_evidence_run_idx` ON `ai_evidence` (`run_id`);

-- --------------------------------------------------------------------
-- Travaux differes
-- --------------------------------------------------------------------
-- Passe par la file d'attente existante plutot que par une seconde file :
-- le consommateur repartit deja par type de tache, et l'offre gratuite
-- compte 10 000 operations par jour toutes files confondues. En ouvrir une
-- deuxieme aurait ajoute une liaison, un binding et un point de panne, pour
-- exactement le meme quota.
CREATE TABLE IF NOT EXISTS `ai_job` (
  `id` text PRIMARY KEY NOT NULL,
  `skill` text NOT NULL,
  `status` text NOT NULL,
  `automatic` integer DEFAULT 0 NOT NULL,
  `input` text NOT NULL,
  `result` text,
  `error` text,
  `created_at` integer NOT NULL,
  `started_at` integer,
  `finished_at` integer
);
CREATE INDEX IF NOT EXISTS `ai_job_status_idx` ON `ai_job` (`status`, `created_at`);

-- --------------------------------------------------------------------
-- Retour de l'utilisateur
-- --------------------------------------------------------------------
-- Sans ce retour, on ne sait jamais si une recommandation etait bonne : les
-- modeles sont convaincants meme quand ils se trompent. C'est la seule
-- mesure de qualite qui ne vienne pas du modele lui-meme.
CREATE TABLE IF NOT EXISTS `ai_feedback` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL REFERENCES `ai_run`(`id`),
  `verdict` text NOT NULL,
  `reason` text,
  `at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `ai_feedback_run_idx` ON `ai_feedback` (`run_id`);
