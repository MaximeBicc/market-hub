# Migration vers VM

## Phase 1 — moteur VM shadow
- runtime Node/Docker ;
- mêmes adaptateurs `@hub/engine` que le Worker ;
- lecture commandes/catalogue ;
- pagination dans la VM ;
- rate limiting local ;
- empreintes de comparaison ;
- aucune écriture marketplace.

## Phase 2 — control plane staging
- D1 staging ;
- lease atomique ;
- observe/complete/fail ;
- copie de données de test ;
- aucune route VM sur la production.

## Phase 3 — comparaison shadow
Comparer ancien moteur et VM :
- commandes détectées ;
- listings ;
- stock distant ;
- curseurs ;
- latence ;
- erreurs ;
- appels réseau.

## Phase 4 — canari
Activer une seule famille d'écritures sur un compte de test, derrière feature
flag et rollback.

## Phase 5 — bascule progressive
Transférer orders, inventory, listings et refresh OAuth ressource par ressource.

## Phase 6 — retrait du polling Cloudflare
Le cron minute et les messages Queue périodiques ne sont retirés qu'après
validation de la VM.
