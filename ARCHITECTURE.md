# Architecture — MarketHub

Outil personnel de gestion multi-boutiques (Shopify, Etsy, eBay, Alibaba).
PWA installable, synchronisation autonome 24 h/24, notifications push.
**Contrainte fondatrice : tout doit tenir dans des offres gratuites, et rien ne
doit tourner sur une machine personnelle.**

---

## 1. Le choix de l'hébergeur

### Pourquoi pas Vercel

Vercel est le réflexe naturel pour une PWA, et c'est un mauvais choix ici, pour
deux raisons indépendantes dont chacune suffirait :

**Les conditions d'utilisation.** Le plan Hobby est réservé à un usage
« personnel ou non commercial ». Vercel définit l'usage commercial comme tout
déploiement servant au gain financier de quiconque participe au projet. Gérer
des boutiques en ligne rentre exactement dans cette définition. Vercel se
réserve le droit de désactiver un projet Hobby sans préavis — l'outil sur
lequel repose votre activité peut disparaître un matin.

**Le cron.** Le plan Hobby limite les tâches planifiées à **une exécution par
jour**. Une synchronisation de commandes toutes les 10 minutes est
techniquement impossible. C'est rédhibitoire pour la fonction principale.

Netlify pose des problèmes analogues, et Render / Fly.io mettent les instances
gratuites en veille après quelques minutes d'inactivité — le cron ne s'exécute
plus.

### Ce que Cloudflare offre en gratuit

| Service | Rôle | Limite gratuite |
|---|---|---|
| Workers | API + PWA + cron + traitement | 100 000 requêtes/jour, 10 ms CPU/invocation |
| Workers Static Assets | fichiers de la PWA | 20 000 fichiers, bande passante illimitée |
| Cron Triggers | déclenchement planifié | 5 déclencheurs/compte, jusqu'à 1×/minute |
| Queues | file d'attente durable | 10 000 opérations/jour, rétention 24 h |
| D1 | base SQLite | 5 Go, 5 M lignes lues/j, 100 k écrites/j |
| Durable Objects | limiteur de débit, verrous | backend SQLite, alarmes incluses |
| KV | cache court, états OAuth | 100 k lectures/j, 1 000 écritures/j |
| R2 | images produits | 10 Go, sans frais de sortie |

Aucune restriction d'usage commercial, aucune mise en veille, et une carte
bancaire n'est pas nécessaire.

**Cloudflare Queues est devenu gratuit le 4 février 2026.** C'est le
changement qui rend cette architecture possible : sans file d'attente durable,
la limite de 50 sous-requêtes par invocation obligerait à des contorsions
fragiles.

---

## 2. Les quatre contraintes qui dictent la conception

Le plan gratuit n'est pas une version bridée du plan payant : il impose des
règles structurelles. Toute l'architecture découle de ces quatre nombres.

### 10 ms de CPU par invocation

Le temps passé à **attendre** le réseau ne compte pas — seul le calcul compte.
Conséquences concrètes :

- Le cron ne fait qu'ordonnancer. Il n'appelle jamais une API externe.
- On ne parse jamais un JSON volumineux d'un bloc : les pages sont bornées.
- Le hachage de contenu se fait par enregistrement, jamais sur un lot entier.

### 50 sous-requêtes par invocation

Chaque `fetch()` **et chaque appel à D1, KV, R2 ou Queues** compte. Une
synchronisation complète d'une boutique de 2 000 annonces en demanderait des
centaines.

C'est la contrainte structurante. La réponse est la file d'attente :

> **1 message de queue = 1 unité de travail = 1 page = ~10 sous-requêtes.**

Chaque message est traité dans sa propre invocation, avec son propre budget.
Le code s'arrête volontairement à 40 sous-requêtes (`SUBREQUEST_BUDGET`) et
remet le reste en file : on ne se fait jamais couper au milieu d'une écriture.

### 6 connexions sortantes simultanées

Un `Promise.all` sur vingt `fetch` échoue de manière non déterministe — le pire
type de panne, celle qui ne se reproduit pas en test. Les connecteurs appellent
donc le réseau **séquentiellement**, via le `http` instrumenté qui leur est
fourni.

### 5 déclencheurs cron par compte

Trois suffisent, chacun avec un rôle distinct :

| Expression | Rôle |
|---|---|
| `*/5 * * * *` | empile les tâches dues (commandes, stock) |
| `17 * * * *` | rafraîchit les jetons OAuth proches de l'expiration |
| `40 3 * * *` | catalogue complet, purge du journal, alerte de réautorisation |

---

## 3. Vue d'ensemble

```
                         ┌──────────────────────────┐
   Téléphone / navigateur│   PWA (React + Vite)     │
                         │   service worker, push    │
                         └───────────┬──────────────┘
                                     │ HTTPS, même origine
                                     │ cookie de session HttpOnly
              ┌──────────────────────▼───────────────────────┐
              │        Cloudflare Worker (un seul)           │
              │                                              │
              │  fetch()      → PWA statique + /api/*        │
              │  scheduled()  → cron : ordonnancement seul   │
              │  queue()      → traitement réel du travail   │
              └───┬────────┬─────────┬──────────┬────────────┘
                  │        │         │          │
            ┌─────▼──┐ ┌───▼───┐ ┌───▼────┐ ┌───▼─────────────┐
            │   D1   │ │  KV   │ │   R2   │ │ Durable Objects │
            │ SQLite │ │ cache │ │ images │ │ débit + verrous │
            └────────┘ └───────┘ └────────┘ └─────────────────┘
                  ▲
                  │
            ┌─────┴──────────┐        ┌──────────────────────────┐
            │ Cloudflare     │◄───────┤ Connecteurs              │
            │ Queues         │        │ Shopify · Etsy · eBay ·  │
            │ (tampon)       │        │ Alibaba · Claude         │
            └────────────────┘        └──────────────────────────┘
```

Un **seul** déploiement expose trois surfaces. La PWA et l'API partagent la
même origine : pas de CORS à configurer, et les cookies de session fonctionnent
sans réglage particulier.

---

## 4. La couche connecteurs

Le risque principal d'un outil multi-plateformes est la contamination : du code
spécifique à Etsy qui remonte dans le tableau de bord, et qu'il faut ensuite
dupliquer pour eBay. L'architecture l'interdit par construction.

```
packages/core/          modèle de domaine unifié
   UnifiedOrder, UnifiedListing, Money, Page<T>, ConnectorError

packages/connectors/
   types.ts             l'interface MarketplaceConnector
   index.ts             le registre — SEUL point d'entrée
   shopify.ts  etsy.ts  ebay.ts  alibaba.ts
```

**Aucun fichier hors de `connectors/` n'importe un connecteur concret.**
Ajouter une cinquième place de marché = un fichier + une ligne dans le registre.

Chaque connecteur expose : OAuth (URL, échange, rafraîchissement), lecture
(commandes, annonces), écriture (stock, prix), webhooks (vérification, analyse,
application), et ses limites de débit déclarées.

### Ce que chaque plateforme impose

| | Jeton d'accès | Rafraîchissement | Webhooks | Débit |
|---|---|---|---|---|
| **Shopify** | n'expire pas (offline) | inutile | oui, HMAC-SHA256 | seau percé, coût GraphQL |
| **eBay** | 2 heures | 18 mois | oui, signature ECDSA | ~5 000/jour |
| **Etsy** | 1 heure | **90 jours** | **non** | 10/s, 10 000/jour glissant |
| **Alibaba** | variable | variable | non | signature HMAC par requête |

Trois conséquences directes sur la conception :

**Etsy ne pousse rien.** C'est du polling ou rien. Sa cadence est donc plus
soutenue (10 min) que celle de Shopify et eBay (30 min), qui reçoivent les
événements en temps réel par webhook.

**Le refresh_token Etsy expire au bout de 90 jours.** S'il n'est pas utilisé
avant, il faut tout réautoriser à la main dans un navigateur. C'est le
principal risque opérationnel du projet : la panne serait silencieuse et
surviendrait des semaines plus tard. Deux garde-fous : le cron horaire
rafraîchit bien avant l'échéance, et une notification push part 14 jours avant.

**eBay n'utilise pas d'URL de rappel.** Il attend un « RuName », un alias créé
dans le portail développeur. C'est le champ `redirectAlias` de `AppCredentials`.

---

## 5. Le cycle de synchronisation

```
  cron */5           Queue                consommateur              D1
     │                 │                       │                    │
     │ lit sync_job    │                       │                    │
     │ (nextRunAt ≤ ?) │                       │                    │
     ├────────────────►│ sendBatch             │                    │
     │  1 sous-requête │  (≤100 messages)      │                    │
     │                 ├──────────────────────►│                    │
     │                 │   ≤5 messages/lot     │ jeton valide ?     │
     │                 │                       ├── DO : verrou ─────┤
     │                 │                       │ rafraîchit si besoin
     │                 │                       │                    │
     │                 │                       │ DO : token bucket  │
     │                 │                       ├── autorisé ? ──────┤
     │                 │                       │                    │
     │                 │                       │ fetch API (≤10)    │
     │                 │                       │                    │
     │                 │                       │ diff par empreinte │
     │                 │                       ├───────────────────►│
     │                 │                       │ n'écrit que le delta
     │                 │◄──────────────────────┤                    │
     │                 │ page suivante ?       │                    │
     │                 │ nouveau message,      │                    │
     │                 │ budget neuf           │                    │
```

### Le diff par empreinte

C'est la mesure qui décide si le projet tient dans le quota gratuit de D1.

Chaque annonce et chaque commande porte une empreinte SHA-256 de son contenu
normalisé (clés triées, sinon deux objets identiques produiraient des
empreintes différentes). À la synchronisation, on compare l'empreinte reçue à
celle en base et **on n'écrit que si elle diffère**.

Sans ce mécanisme, resynchroniser 2 000 annonces toutes les 15 minutes coûterait
192 000 écritures par jour : la base serait coupée avant midi. Avec, on écrit
les quelques dizaines d'annonces dont le prix ou le stock a réellement bougé.

### Le Durable Object

Un objet par boutique, qui rend deux services impossibles à obtenir autrement
dans un environnement sans état :

**Un seul compteur de débit.** Plusieurs invocations du consommateur tournent en
parallèle ; sans point de rendez-vous, elles dépasseraient les quotas des
plateformes et se feraient bannir. Le Durable Object est ce point unique,
garanti par Cloudflare, où que soit exécuté le code.

**Un verrou de rafraîchissement.** Si deux tâches constatent simultanément
qu'un jeton eBay a expiré, elles déclenchent deux rafraîchissements : le second
invalide le premier, et la boutique tombe en panne.
`blockConcurrencyWhile()` sérialise l'opération.

Le limiteur **ne bloque jamais** : il renvoie « refusé, réessayez dans N ms »,
et le message repart en file avec ce délai. Attendre consommerait du CPU, dont
on ne dispose que de 10 ms.

---

## 6. Les webhooks

Les seules routes publiques. Elles ne sont pas protégées par la session — les
plateformes n'en ont pas — mais par la signature cryptographique du corps.

Trois règles sans exception :

1. **Lire le corps brut une seule fois, et vérifier la signature dessus.** Un
   `JSON.parse` suivi d'un `JSON.stringify` réordonne les clés et change les
   espaces : le HMAC ne correspond plus. C'est l'erreur classique.
2. **Répondre vite.** Shopify considère le webhook comme échoué au-delà de
   ~5 secondes et finit par désactiver l'abonnement. On vérifie, on déduplique,
   on empile, on rend la main.
3. **Dédupliquer.** Les plateformes garantissent « au moins une fois », pas
   « exactement une fois ». La table `webhook_receipt` fait office de barrière,
   sa clé primaire faisant le travail.

Une signature invalide reçoit `401` sans explication : ne jamais indiquer à un
attaquant ce qui n'allait pas dans sa signature.

---

## 7. Sécurité

### Authentification : clés d'accès (WebAuthn)

Aucun mot de passe n'existe dans ce système, donc aucun ne peut fuiter, être
réutilisé ailleurs ou faire l'objet d'un hameçonnage. Sur téléphone, la
connexion se fait par Face ID ou empreinte ; sur ordinateur, par Windows Hello
ou Touch ID. La clé est liée cryptographiquement au domaine : un faux site,
même parfaitement imité, ne peut pas la solliciter.

La base ne contient que des clés **publiques** : leur fuite est sans
conséquence.

> ⚠️ **Enregistrez deux appareils.** Une seule clé enregistrée sur un unique
> téléphone signifie que perdre ce téléphone revient à perdre l'accès. La
> procédure de secours consiste à insérer une clé d'accès directement en base
> via `wrangler d1 execute`, ce qui suppose un accès au compte Cloudflare.

### Chiffrement des jetons au repos

Les jetons OAuth sont chiffrés en **AES-256-GCM** avant d'atteindre la base. La
clé maître vit dans les secrets du Worker, pas dans la base : une copie de la
base qui fuiterait ne donnerait accès à aucune boutique.

GCM chiffre **et** authentifie : un octet modifié fait échouer le déchiffrement
au lieu de produire silencieusement des données fausses. Le vecteur
d'initialisation est aléatoire à chaque écriture. Le champ `key_version` permet
une rotation de clé sans interruption.

### Le reste

- **Cookie de session** : `HttpOnly` (immunisé au XSS), `Secure`, `SameSite=Lax`
  (bloque le CSRF tout en survivant aux retours OAuth), signé en HMAC — un
  identifiant modifié est rejeté sans même interroger la base.
- **OAuth** : `state` anti-CSRF à usage unique et PKCE sur toutes les
  plateformes, stockés dans KV avec 10 minutes de durée de vie. Sans `state`,
  un attaquant peut vous faire connecter *sa* boutique à *votre* compte, et lire
  ensuite tout ce que vous y écrivez.
- **CSP stricte** : `connect-src 'self'`. Aucune API externe n'est appelée
  depuis le navigateur — tout passe par le Worker — donc la politique peut
  rester complètement fermée.
- **Clés d'API** : uniquement dans les secrets du Worker. Une clé Claude dans un
  bundle JavaScript est publique, point final.

---

## 8. Notifications push

Web Push (VAPID), sans service tiers ni SDK propriétaire.

La bibliothèque `web-push` s'appuie sur le module `crypto` de Node et ne
fonctionne pas dans un Worker : on utilise `@block65/webcrypto-web-push`, qui
n'emploie que la WebCrypto standard.

> ⚠️ **Sur iPhone et iPad**, le push web ne fonctionne que si la PWA a été
> ajoutée à l'écran d'accueil et lancée depuis son icône. Dans Safari, l'API
> Push est absente. Il faut iOS 16.4 ou plus. Sur Android et sur ordinateur,
> aucune de ces restrictions.
>
> L'interface détecte ce cas en premier et affiche « Ajoutez l'app à votre écran
> d'accueil » plutôt qu'une erreur incompréhensible.

Les règles d'alerte sont évaluées **après** le diff, donc uniquement sur ce qui
a réellement changé. Un produit à 2 exemplaires depuis trois semaines ne
déclenche pas une notification tous les quarts d'heure. Un délai de garde par
règle empêche le tir en rafale quand une synchronisation remonte trente annonces
d'un coup.

---

## 9. L'assistant IA

Seul poste payant de l'architecture, et strictement optionnel.

- Modèle `claude-opus-5`, réflexion adaptative, effort `medium`.
- **Sorties structurées** (schémas Zod) : le modèle renvoie du JSON validé, pas
  du texte à analyser.
- **Cache de prompt** sur le prompt système, qui ne contient ni date ni
  identifiant — la moindre valeur variable invaliderait le cache à chaque appel,
  sans qu'aucune erreur ne le signale.
- **Plafond mensuel de jetons** appliqué dans le code, compteur en KV. Sans lui,
  une boucle mal écrite peut coûter cher pendant la nuit.

Usages prévus : rédaction de fiches produit, conseil de prix multi-canal.

---

## 10. Budget des quotas

Hypothèse : **4 boutiques**, commandes toutes les 10 min, stock toutes les
15 min, catalogue une fois par jour.

| Ressource | Consommation estimée | Limite gratuite | Marge |
|---|---|---|---|
| Requêtes Workers/jour | ~3 700 | 100 000 | 27× |
| Opérations Queues/jour | ~3 500 | 10 000 | 2,9× |
| Lignes D1 écrites/jour | ~3 000 | 100 000 | 33× |
| Lignes D1 lues/jour | ~60 000 | 5 000 000 | 83× |
| Écritures KV/jour | ~50 | 1 000 | 20× |
| Stockage D1 | < 100 Mo | 5 Go | 50× |

**Le facteur limitant est la file d'attente**, avec un facteur 3 seulement. Le
plafond `MAX_TASKS_PER_TICK = 20` du planificateur est le garde-fou : il borne
la consommation quoi qu'il arrive.

Marges de manœuvre si vous approchez la limite : allonger les intervalles,
augmenter la taille des pages, ou activer les webhooks Shopify/eBay (qui
remplacent le polling par de l'événementiel). En dernier recours, le plan
Workers payant coûte 5 $/mois et multiplie ces limites par cent.

---

## 11. Risques et limites connus

| Risque | Gravité | Mitigation en place |
|---|---|---|
| Refresh token Etsy expiré (90 j) | élevée — panne silencieuse | cron horaire + alerte push à 14 jours |
| Perte du seul appareil enregistré | élevée — perte d'accès | enregistrer 2 clés ; secours via `wrangler d1 execute` |
| Quota Queues dépassé | moyenne — sync arrêtée jusqu'à minuit UTC | plafond par tick, repli exponentiel |
| eBay refuse une URL `workers.dev` | moyenne — bloque la connexion eBay | à vérifier tôt ; sinon, domaine à ~10 €/an |
| API d'une plateforme modifiée | moyenne | connecteur isolé : un seul fichier à corriger |
| Cloudflare change son offre gratuite | faible | code standard (Hono, Drizzle, SQLite), migrable |
| Signature ECDSA eBay non implémentée | faible | les webhooks eBay sont refusés ; le polling prend le relais |

### Ce qui n'est pas dans le périmètre

- **Le connecteur Alibaba est un squelette** : OAuth et signature des requêtes
  sont écrits, la cartographie des données ne l'est pas. L'API dépend du
  programme auquel votre compte est rattaché (Alibaba.com International,
  AliExpress et 1688 sont trois surfaces différentes).
- **Les webhooks eBay ne sont pas vérifiés** : `verifyWebhook` renvoie `false`,
  donc refuse tout. C'est volontaire — jamais d'acceptation par défaut. La
  synchronisation eBay passe par le polling en attendant.
- **`updatePrice` eBay** demande de mémoriser l'`offerId` au moment de la
  synchronisation du catalogue.
- **Les icônes PWA** (`apps/web/public/icons/`) sont à fournir.

---

## 12. Évolutions naturelles

1. **Nom de domaine** (~10 €/an) : URL propre, et surtout accès à Cloudflare
   Access — authentification gérée à la périphérie, sans code à maintenir. Le
   seul poste qui vaille la peine de quitter le gratuit.
2. **Rapprochement des produits** : la table `product` existe déjà, le champ
   `listing.productId` n'est pas encore alimenté. C'est ce qui permettrait la
   propagation de stock entre canaux.
3. **Alarmes de Durable Object** pour des synchronisations à la seconde près sur
   une boutique donnée, sans consommer de déclencheur cron.
4. **R2** pour archiver les payloads bruts : rejouer un mapping sans
   re-télécharger auprès de la plateforme.
