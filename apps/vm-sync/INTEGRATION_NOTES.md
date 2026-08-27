# Notes sur le Market Hub actuel

Vérifié sur `vm-staging` avant l'ajout de ce module :

- `apps/worker/src/scheduler.ts` déclenche le relevé chaque minute ;
- les jobs dus sont envoyés dans `SYNC_QUEUE` ;
- `apps/worker/src/engine/sync.ts` exécute la synchronisation périodique ;
- le moteur réel est `@hub/engine` ;
- `apps/worker/src/engine/module.ts` enregistre Shopify, eBay, Etsy, Alibaba,
  VintedSafe et Mock ;
- `.github/workflows/deploy.yml` ne déploie automatiquement que les pushes
  vers `main`.

La VM phase 1 ne modifie volontairement aucun de ces fichiers de production.
