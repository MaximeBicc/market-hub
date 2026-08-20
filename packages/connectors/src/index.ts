import type { Platform } from "@hub/core";
import type { MarketplaceConnector } from "./types.js";
import { shopifyConnector } from "./shopify.js";
import { etsyConnector } from "./etsy.js";
import { ebayConnector } from "./ebay.js";
import { alibabaConnector } from "./alibaba.js";

export * from "./types.js";

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
