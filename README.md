# MarketHub

PWA privée de gestion multi-boutiques (Shopify, Etsy, eBay, Alibaba).
Installable sur téléphone, accessible depuis n'importe où, synchronisation
automatique 24 h/24 — **sans rien faire tourner sur vos machines**.

Conception détaillée et justification de chaque choix : [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Coût

| Poste | Fournisseur | Coût |
|---|---|---|
| Hébergement, API, cron, file d'attente | Cloudflare Workers | 0 € |
| Base de données | Cloudflare D1 | 0 € |
| Notifications push | Web Push (VAPID) | 0 € |
| CI/CD | GitHub Actions | 0 € |
| Nom de domaine | `*.workers.dev` | 0 € |
| Assistant IA (optionnel) | Claude API | à l'usage, plafonné dans le code |

Aucune carte bancaire n'est requise pour le plan gratuit Cloudflare.

---

## Mise en ligne

Trois commandes. Les dépendances sont déjà installées et les secrets
cryptographiques déjà générés dans `.dev.vars` (fichier non versionné).

### 1. Se connecter à Cloudflare

Créez un compte gratuit sur [dash.cloudflare.com](https://dash.cloudflare.com)
si vous n'en avez pas — aucune carte bancaire n'est demandée. Puis :

```bash
pnpm exec wrangler login
```

Une page s'ouvre dans le navigateur : autorisez l'accès.

### 2. Provisionner et déployer

```bash
pnpm setup
```

Ce script fait tout, et il est rejouable sans risque :

| Étape | Ce qui se passe |
|---|---|
| 1 | vérifie la session Cloudflare |
| 2 | crée la base D1 `market-hub-db` |
| 3 | crée l'espace KV `CACHE` |
| 4 | crée les files `market-hub-sync` et `market-hub-dlq` |
| 5 | inscrit les identifiants obtenus dans `wrangler.jsonc` |
| 6 | construit la PWA |
| 7 | déploie une première fois pour découvrir l'URL `workers.dev` |
| 8 | inscrit cette URL dans `APP_URL`, envoie les secrets, applique le schéma |
| 9 | redéploie avec la configuration définitive |

Les deux déploiements ne sont pas un gaspillage : l'URL n'est connue qu'après
le premier, et `APP_URL` sert à calculer les adresses de rappel OAuth ainsi que
l'identifiant de domaine WebAuthn. Une valeur fausse fait échouer la connexion
sans message clair.

### 3. Vérifier

Le script affiche l'URL finale. Pour confirmer que tout répond :

```bash
curl https://market-hub.VOTRE-SOUS-DOMAINE.workers.dev/api/health
```

Réponse attendue : `{"ok":true,"app":"MarketHub"}`

Ouvrez ensuite l'URL dans un navigateur et créez votre accès par clé d'accès.

---

## Développement local

```bash
pnpm exec wrangler d1 migrations apply market-hub-db --local
```

Puis, dans deux terminaux :

```bash
pnpm dev:web
```

```bash
pnpm exec wrangler dev --test-scheduled
```

Le front tourne sur `http://localhost:5173` avec rechargement à chaud, le back
sur `http://localhost:8787` avec de vraies liaisons D1, KV et Queue locales.

Pour déclencher le cron à la main sans attendre cinq minutes :

```bash
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

---

## Installer sur le téléphone

**Android (Chrome)** — ouvrez l'URL, menu ⋮ → « Installer l'application ».

**iPhone (Safari, iOS 16.4+)** — ouvrez l'URL, bouton Partager → « Sur l'écran
d'accueil ». Puis **rouvrez l'app depuis son icône** : sur iOS, les
notifications push ne fonctionnent que dans ce mode, jamais dans Safari.

Activez ensuite les notifications dans Réglages → Notifications, et utilisez le
bouton « Envoyer un test » pour vérifier.

---

## Enregistrer les applications chez les plateformes

| Plateforme | Où | URL de rappel à déclarer |
|---|---|---|
| Shopify | Partner Dashboard → Apps | `{APP_URL}/api/oauth/shopify/callback` |
| Etsy | etsy.com/developers/your-apps | `{APP_URL}/api/oauth/etsy/callback` |
| eBay | developer.ebay.com/my/keys | créez un **RuName** pointant vers `{APP_URL}/api/oauth/ebay/callback` |
| Alibaba | openapi.alibaba.com | `{APP_URL}/api/oauth/alibaba/callback` |

Webhooks (Shopify et eBay uniquement) : `{APP_URL}/api/webhooks/{plateforme}`.

---

## Structure

```
apps/
  web/          PWA React — interface, service worker, manifest
  worker/       Cloudflare Worker — API, cron, consommateur de queue
    src/
      routes/   HTTP : auth, oauth, webhooks, api, ai
      lib/      chiffrement, sessions, jetons, push, alertes, http instrumenté
      do/       Durable Object : limiteur de débit et verrou de rafraîchissement
      db/       schéma Drizzle
    migrations/ migrations SQL D1
packages/
  core/         modèle de domaine unifié — ne connaît aucune plateforme
  connectors/   un fichier par place de marché, derrière une interface unique
```

---

## État d'avancement

| Composant | État |
|---|---|
| Infrastructure, cron, queue, limiteur de débit | complet |
| Authentification par clé d'accès | complet |
| Chiffrement des jetons, cycle de rafraîchissement | complet |
| Notifications push et règles d'alerte | complet |
| Connecteur Shopify | complet (référence) |
| Connecteur Etsy | complet |
| Connecteur eBay | OAuth et lecture ; signature des notifications à finir |
| Connecteur Alibaba | OAuth et signature ; cartographie des données à faire |
| Icônes PWA | générées (remplaçables) |
