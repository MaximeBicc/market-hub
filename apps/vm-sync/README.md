# Market Hub — moteur de synchronisation VM

Première brique de la migration du polling Cloudflare vers une VM.

## Sécurité de cette phase

Cette version est **shadow/read-only** :

- aucun prix n'est modifié ;
- aucun stock n'est modifié ;
- aucune annonce n'est créée, activée ou désactivée ;
- aucune ressource Cloudflare de production n'est modifiée ;
- `VM_SYNC_MODE=shadow` est le mode normal ;
- le mode `active` possède un second verrou explicite.

Le workflow GitHub de production ne se déclenche que sur `main`, donc un push sur
`vm-staging` ne déploie pas Market Hub en production.

## Réutilisation du moteur réel

La VM utilise directement les adaptateurs de `@hub/engine` :

- `ShopifyAdapter`
- `EbayAdapter`
- `EtsyAdapter`
- `AlibabaAdapter`
- `VintedSafeAdapter`
- `MockAdapter`

C'est le même jeu d'adaptateurs que `apps/worker/src/engine/module.ts`.

## Architecture phase 1

```text
Worker STAGING / D1 STAGING
          |
          | lease
          v
      VM Sync
          |
          +--> pollOrderEvents()
          |
          +--> fetchListings()
          |
          +--> empreintes SHA-256
          |
          `--> observation shadow -> Worker STAGING
```

La VM parcourt les pages dans le même processus : elle n'a donc pas besoin
d'envoyer un message Cloudflare Queue pour chaque page.

## Démarrage

```bash
cp apps/vm-sync/.env.example apps/vm-sync/.env
pnpm install
pnpm --filter @hub/vm-sync dev
```

Ou :

```bash
docker compose -f apps/vm-sync/docker-compose.yml up --build
```

Le service expose :

```text
GET /health
GET /ready
```

## Étape suivante

Ajouter dans le Worker **staging uniquement** les routes privées :

- `GET /api/internal/vm-sync/lease`
- `POST /api/internal/vm-sync/observe`
- `POST /api/internal/vm-sync/complete`
- `POST /api/internal/vm-sync/fail`

Ces routes devront être reliées à une D1 staging, jamais à la D1 production
pendant la phase de développement.
