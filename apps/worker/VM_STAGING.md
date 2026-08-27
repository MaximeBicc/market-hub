# Phase 2 — Control plane VM + D1 staging

Cette phase est isolée de la production par quatre barrières :

1. branche Git `vm-staging` ;
2. Worker distinct `market-hub-vm-staging-control` ;
3. D1 distincte `market-hub-db-staging` ;
4. allowlist de comptes vide/explicite + Bearer token dédié.

Le Worker staging n'exporte ni `scheduled()` ni `queue()`. Il ne peut donc pas
consommer `market-hub-sync` ni lancer les cron de production.

## 1. Préparer la configuration

```bash
cp wrangler.vm-staging.example.jsonc wrangler.vm-staging.jsonc
npx wrangler d1 create market-hub-db-staging
```

Recopier le `database_id` retourné dans `wrangler.vm-staging.jsonc`.

## 2. Créer le schéma staging

```bash
npx wrangler d1 migrations apply market-hub-db-staging \
  --remote --config wrangler.vm-staging.jsonc
```

Les migrations créent le schéma Market Hub puis les tables :

- `vm_sync_lease` : location atomique d'un `sync_job` ;
- `vm_sync_observation` : résultats shadow et empreintes de comparaison.

## 3. Injecter uniquement le compte factice

```bash
npx wrangler d1 execute market-hub-db-staging \
  --remote --config wrangler.vm-staging.jsonc \
  --file apps/worker/staging/seed-vm-mock.sql
```

Le compte `vm-stage-mock` n'a aucun OAuth et ne contacte aucune marketplace.
Il valide le protocole `lease -> observe -> complete/fail` sans risque externe.

## 4. Secrets STAGING

Créer une clé maître distincte de la production :

```bash
openssl rand -base64 32
npx wrangler secret put MASTER_KEY --config wrangler.vm-staging.jsonc
```

Puis un token de control plane long et aléatoire :

```bash
openssl rand -hex 32
npx wrangler secret put VM_CONTROL_PLANE_TOKEN --config wrangler.vm-staging.jsonc
```

Le même `VM_CONTROL_PLANE_TOKEN` est placé dans `apps/vm-sync/.env` sous
`CONTROL_PLANE_TOKEN`.

## 5. Déployer le Worker staging

```bash
npx wrangler deploy --config wrangler.vm-staging.jsonc
```

Vérification publique minimale :

```bash
curl https://<worker-staging>/health
```

Vérification privée :

```bash
curl -H "Authorization: Bearer $VM_CONTROL_PLANE_TOKEN" \
  https://<worker-staging>/api/internal/vm-sync/status
```

## 6. Brancher la VM

Dans `apps/vm-sync/.env` :

```env
VM_SYNC_MODE=shadow
CONTROL_PLANE_URL=https://<worker-staging>
CONTROL_PLANE_TOKEN=<meme-token>
ALLOW_MARKETPLACE_WRITES=NO
```

Puis :

```bash
pnpm --filter @hub/vm-sync start
```

Le compte mock renverra `supported=false` pour les lectures : c'est attendu à
ce stade. L'objectif de phase 2 est de valider le transport, la location,
l'observation, la reprise après échec et l'isolation D1 — pas une marketplace.

## Garde-fous avant un compte réel

`VM_SYNC_ACCOUNT_ALLOWLIST` est obligatoire. Une chaîne vide signifie **zéro
travail**. N'ajouter aucun identifiant de boutique de production en phase 2.

`VM_ALLOW_CREDENTIAL_PERSIST=false` doit rester faux. Certains fournisseurs
font tourner leur refresh token : une VM shadow qui persisterait un nouveau
jeton pourrait invalider celui encore utilisé par la production.
