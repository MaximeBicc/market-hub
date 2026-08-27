import type { CapabilitySet } from "../domain/types.js";

/**
 * QUI RELÈVE QUOI, ET À QUELLE CADENCE.
 *
 * Cette politique était écrite deux fois : une version aveugle aux capacités,
 * exécutée à la connexion d'un compte, et une version informée, exécutée
 * ensuite. C'est l'aveugle qui gagnait — d'où trois relevés actifs sur un
 * compte Alibaba qui ne vend rien, chacun consommant ses opérations de file
 * pour arriver à « rien à faire ».
 *
 * Elle vit désormais ici, en fonction pure, pour deux raisons : il ne peut
 * plus y en avoir deux, et une politique qui décide de la consommation
 * quotidienne mérite d'être éprouvée autrement qu'en production.
 */

export interface Releve {
  resource: "orders" | "inventory" | "listings";
  intervalSec: number;
  enabled: boolean;
}

/** Le filet quand la plateforme pousse. */
export const CADENCE_FILET = 900;
/** La cadence quand elle ne pousse rien, et qu'il faut aller voir. */
export const CADENCE_RELEVE = 120;
/** Le catalogue complet : une fois par jour suffit. */
export const CADENCE_CATALOGUE = 86400;

/**
 * @param capacites Ce que l'adaptateur déclare savoir faire.
 * @param abonne Vrai si les abonnements aux webhooks ont RÉELLEMENT été créés.
 */
export function planReleves(
  capacites: CapabilitySet,
  abonne: boolean,
): Releve[] {
  /*
   * « Pousse » ne veut pas dire « saurait pousser » mais « pousse
   * effectivement ». Shopify SAIT envoyer des webhooks ; encore faut-il lui
   * avoir demandé. Détendre le relevé sur la seule capacité déclarée
   * ralentirait une boutique dont les abonnements n'ont jamais été créés —
   * exactement l'inverse du but.
   */
  const pousse =
    abonne &&
    (capacites.inboundSales === "webhook" || capacites.inboundSales === "both");

  const cadence = pousse ? CADENCE_FILET : CADENCE_RELEVE;

  return [
    /*
     * 120 secondes plutôt que 60 quand rien n'est poussé : Etsy plafonne à
     * 10 000 requêtes par jour et lit son catalogue état par état — quatre
     * appels par passage. À la minute, le seul relevé mangerait les trois
     * quarts du quota et ne laisserait plus de marge aux actions manuelles.
     */
    { resource: "orders", intervalSec: cadence, enabled: capacites.ordersRead },
    {
      resource: "inventory",
      intervalSec: cadence,
      enabled: capacites.stockRead,
    },
    /*
     * Le catalogue complet — titres, descriptions, photos — ne bouge pas
     * d'une heure à l'autre. Le relever souvent coûte cher et n'apprend rien.
     */
    {
      resource: "listings",
      intervalSec: CADENCE_CATALOGUE,
      enabled: capacites.stockRead,
    },
  ];
}

/**
 * Le coût quotidien d'un plan, en opérations de file.
 *
 * Cloudflare facture l'écriture, la lecture et la suppression de chaque
 * message : trois opérations par tâche, quota gratuit de dix mille par jour.
 * Savoir compter cela AVANT de connecter une dixième boutique évite de le
 * découvrir en voyant la synchronisation s'arrêter.
 */
export function coutQuotidien(plan: Releve[]): {
  taches: number;
  operations: number;
} {
  const taches = plan
    .filter((r) => r.enabled)
    .reduce((n, r) => n + Math.floor(86400 / r.intervalSec), 0);
  return { taches, operations: taches * 3 };
}

/**
 * Découpe des tâches en lots transportables par un seul message.
 *
 * Cloudflare facture l'écriture, la lecture et la suppression de CHAQUE
 * message : trois opérations, quel que soit son contenu. Grouper l'envoi ne
 * change rien — c'est le contenu qu'il faut grouper.
 *
 * La taille n'est pas libre : les tâches d'un lot partagent le budget de
 * sous-requêtes de l'invocation. Trop grand, le lot se fait interrompre et
 * chaque report coûte à nouveau un message.
 */
export function decouperEnLots<T>(taches: T[], taille: number): T[][] {
  if (taille < 1) throw new Error("La taille d'un lot vaut au moins un");
  const lots: T[][] = [];
  for (let i = 0; i < taches.length; i += taille) {
    lots.push(taches.slice(i, i + taille));
  }
  return lots;
}

/**
 * Ce que coûtent des tâches une fois groupées.
 *
 * La comparaison avec `coutQuotidien` — trois opérations par tâche — donne le
 * facteur d'économie réel.
 */
export function coutGroupe(taches: number, taille: number): number {
  return decouperEnLots(new Array(taches).fill(0), taille).length * 3;
}
