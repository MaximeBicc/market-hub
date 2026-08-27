# Protocole Worker staging ↔ VM

Toutes les routes sont privées sous `/api/internal/vm-sync/*` et exigent :

```http
Authorization: Bearer <CONTROL_PLANE_TOKEN>
```

Elles doivent être déployées dans l'environnement **staging** et utiliser la
base D1 staging.

## Lease

`GET /api/internal/vm-sync/lease?limit=4`

Réponse :

```json
{
  "leases": [
    {
      "leaseId": "lease_...",
      "leasedUntil": 1787838000,
      "resource": "orders",
      "cursor": null,
      "account": {
        "id": "shop_...",
        "marketplace": "ebay",
        "slug": "ebay-principal",
        "displayName": "eBay principal",
        "enabled": true,
        "externalAccountId": "..."
      },
      "credentials": {
        "clientId": "...",
        "clientSecret": "...",
        "accessToken": "...",
        "refreshToken": "..."
      }
    }
  ]
}
```

Les credentials sont temporaires, chiffrés au repos côté Worker et transmis
uniquement à la VM authentifiée en HTTPS. Ils ne doivent jamais être loggés.

## Observe

`POST /api/internal/vm-sync/observe`

Stocke les métriques shadow : pages, items, empreintes, curseur final et
éventuel `credentialPatch`.

## Complete

`POST /api/internal/vm-sync/complete`

```json
{ "leaseId": "lease_..." }
```

## Fail

`POST /api/internal/vm-sync/fail`

La VM renvoie l'erreur et son caractère réessayable. Le control plane décide du
backoff.

## Règle de phase 1

La VM ne reçoit aucune commande d'écriture marketplace. Elle n'appelle que
`pollOrderEvents` et `fetchListings`.
