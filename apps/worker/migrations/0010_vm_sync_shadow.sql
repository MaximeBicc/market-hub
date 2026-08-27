-- Control plane VM / shadow staging.
--
-- Ces tables ne remplacent PAS sync_job : elles ajoutent uniquement la notion
-- de location atomique par une VM et l'historique de comparaison shadow.

CREATE TABLE `vm_sync_lease` (
  `sync_job_id` text PRIMARY KEY NOT NULL REFERENCES `sync_job`(`id`) ON DELETE CASCADE,
  `lease_id` text NOT NULL,
  `leased_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `completed_at` integer,
  `last_failure` text,
  `failure_at` integer,
  `attempts` integer NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX `vm_sync_lease_id_idx` ON `vm_sync_lease` (`lease_id`);
CREATE INDEX `vm_sync_lease_expires_idx` ON `vm_sync_lease` (`expires_at`, `completed_at`);

CREATE TABLE `vm_sync_observation` (
  `id` text PRIMARY KEY NOT NULL,
  `lease_id` text NOT NULL,
  `sync_job_id` text NOT NULL REFERENCES `sync_job`(`id`) ON DELETE CASCADE,
  `shop_id` text NOT NULL REFERENCES `shop`(`id`) ON DELETE CASCADE,
  `marketplace` text NOT NULL,
  `resource` text NOT NULL,
  `started_at` integer NOT NULL,
  `finished_at` integer NOT NULL,
  `pages` integer NOT NULL,
  `items` integer NOT NULL,
  `supported` integer NOT NULL DEFAULT 1,
  `fingerprints` text NOT NULL DEFAULT '[]',
  `terminal_cursor` text,
  `credential_patch` text,
  `vm_mode` text NOT NULL,
  `created_at` integer NOT NULL
);

CREATE INDEX `vm_sync_observation_lease_idx` ON `vm_sync_observation` (`lease_id`, `created_at`);
CREATE INDEX `vm_sync_observation_shop_idx` ON `vm_sync_observation` (`shop_id`, `resource`, `created_at`);
