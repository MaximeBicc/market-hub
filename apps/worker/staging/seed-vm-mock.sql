-- Données de test STRICTEMENT destinées à la D1 staging.
-- Aucun OAuth, aucun compte marchand réel, aucun appel externe.

INSERT OR IGNORE INTO `shop` (
  `id`, `platform`, `external_id`, `display_name`, `slug`, `status`, `config`, `connected_at`
) VALUES (
  'vm-stage-mock', 'mock', 'vm-stage-mock', 'VM Staging Mock', 'vm_staging_mock', 'active', '{}', unixepoch()
);

INSERT OR IGNORE INTO `sync_job` (
  `id`, `shop_id`, `resource`, `interval_sec`, `next_run_at`, `enabled`
) VALUES
  ('vm-stage-mock-orders', 'vm-stage-mock', 'orders', 60, 0, 1),
  ('vm-stage-mock-listings', 'vm-stage-mock', 'listings', 60, 0, 1);
