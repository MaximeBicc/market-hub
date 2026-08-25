import type { Platform } from "@hub/core";
import type { MarketplaceConnector } from "./types.js";
import { shopifyConnector } from "./shopify.js";
import { etsyConnector } from "./etsy.js";
import { ebayConnector } from "./ebay.js";
import { alibabaConnector } from "./alibaba.js";

export * from "./types.js";

/*
 * La seule chose qu'un connecteur concret exporte hors de ce registre.
 *
 * La règle du fichier — personne n'importe un connecteur concret — vaut pour
 * les CONNECTEURS. `signRequest` n'en est pas un : c'est la primitive de
 * signature d'Alibaba, dont la sonde de diagnostic a besoin pour poser UN
 * appel brut sans passer par une cartographie qui n'existe pas encore.
 *
 * La réexporter vaut mieux que la recopier : deux implémentations d'une même
 * signature finissent toujours par diverger d'un espace, et l'écart ne se voit
 * qu'au refus de l'appel.
 */
export { signRequest } from "./alibaba.js";

/**
 * Registre : le SEUL point d'entrée vers les connecteurs.
 *
 * Ajouter une place de marché = écrire un fichier + une ligne ici. Aucun autre
 * fichier du dépôt ne doit importer un connecteur concret.
 */
const REGISTRY: Record<Platform, MarketplaceConnector> = {
  shopify: shopifyConnector,
  etsy: etsyConnector,
  ebay: ebayConnector,
  alibaba: alibabaConnector,
};

export function getConnector(platform: Platform): MarketplaceConnector {
  const c = REGISTRY[platform];
  if (!c) throw new Error(`Plateforme inconnue : ${platform}`);
  return c;
}

export function allConnectors(): MarketplaceConnector[] {
  return Object.values(REGISTRY);
}
