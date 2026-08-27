import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { listing } from "../db/schema.js";
import type { Env } from "../env.js";
import { buildEngine } from "../engine/module.js";
import { appliquerDisponibilite } from "./disponibilite.js";
import { recalculerStockProduit } from "./stock-produit.js";
import { d1Repositories } from "../engine/repositories.js";

/** Les dépôts, pour la seule lecture dont ce module a besoin. */
const depots = (env: Env) => d1Repositories(env.DB, env.MASTER_KEY);

/**
 * ÉCRIRE UN STOCK ANNONCÉ PAR UNE PLATEFORME, SANS RIEN RELIRE.
 *
 * Un webhook Shopify de niveau d'inventaire porte déjà toute la réponse :
 * quel article a changé, et à combien. La seule chose qui manque est la
 * traduction de SON identité vers la nôtre.
 *
 * Le chemin d'avant empilait une synchronisation d'inventaire, qui relisait le
 * catalogue page par page pour retrouver la seule variante concernée. Trois
 * opérations de file, une dizaine d'appels réseau, et plusieurs secondes —
 * pour une information qu'on tenait déjà.
 */

/**
 * Retrouve l'unité désignée par la plateforme et adopte sa quantité.
 *
 * Rend `false` quand la correspondance échoue : l'appelant retombe alors sur
 * la relecture. Perdre le signal en silence laisserait un stock faux jusqu'au
 * prochain filet.
 */
export async function appliquerStockDistant(
  env: Env,
  accountId: string,
  refDistante: string,
  disponible: number,
): Promise<boolean> {
  const db = drizzle(env.DB);

  /*
   * La référence distante vit dans le JSON de l'annonce.
   *
   * `json_extract` évite de ramener toutes les lignes pour les filtrer en
   * mémoire. Le filtre sur la boutique passe en premier : sans lui, deux
   * comptes Shopify qui partagent un identifiant d'article — impossible en
   * pratique, mais rien ne l'interdit — se marcheraient dessus.
   */
  const [ligne] = await db
    .select({ variantId: listing.variantId, productId: listing.productId })
    .from(listing)
    .where(
      and(
        eq(listing.shopId, accountId),
        sql`json_extract(${listing.marketplaceData}, '$.inventoryItemId') = ${refDistante}`,
      ),
    )
    .limit(1);

  if (!ligne?.variantId) return false;

  /*
   * LE PRODUIT SE DÉDUIT DE LA VARIANTE QUAND L'ANNONCE NE LE PORTE PAS.
   *
   * Dix-huit des vingt-huit annonces en production portent leur variante sans
   * leur produit — le rattachement se fait par la variante, et la colonne
   * `product_id` de l'annonce n'est pas toujours renseignée. Exiger les deux
   * aurait rejeté près des deux tiers de la flotte, et fait retomber chaque
   * webhook sur la relecture qu'on cherche justement à éviter.
   */
  const productId =
    ligne.productId ??
    (await depots(env).variants.get(ligne.variantId))?.productId;
  if (!productId) return false;

  const mod = buildEngine(env, { used: 0 });

  /*
   * `adopt` et non `set` : la valeur vient de la PLATEFORME, pas d'une
   * décision humaine. La distinction porte la version du stock, et c'est elle
   * qui tranche ensuite « qui a bougé » lors d'une réconciliation. La marquer
   * comme un geste de l'outil ferait repousser cette valeur vers Shopify au
   * passage suivant — un aller-retour pour rien, et un écart de version qui
   * ferait gagner le mauvais côté à la prochaine divergence.
   */
  await mod.inventoryService.ensure(ligne.variantId, 0);
  await mod.inventoryService.adopt(ligne.variantId, Math.max(0, disponible));

  // Le résumé du produit suit, puis la règle de disponibilité : un article qui
  // tombe à zéro chez Shopify doit se retirer des AUTRES boutiques aussi.
  await recalculerStockProduit(db, productId);
  await appliquerDisponibilite(env, productId);

  return true;
}
