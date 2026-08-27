import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { TargetResult } from "@hub/engine";
import { inventory, listing, product, shop, variant } from "../db/schema.js";
import type { Env } from "../env.js";
import { buildEngine } from "../engine/module.js";

/**
 * L'ANNONCE SUIT LE STOCK.
 *
 * Un article épuisé ne doit plus être en vente nulle part. Sans cette règle,
 * le premier acheteur d'un produit à zéro paie quelque chose qu'on ne peut pas
 * lui envoyer — et une commande impossible à honorer coûte bien plus cher
 * qu'une vente manquée : remboursement, évaluation négative, et chez eBay
 * comme chez Etsy un compteur de défauts qui pèse sur le compte.
 *
 * LA GRANULARITÉ EST LE PRODUIT, PAS LA VARIANTE, et c'est délibéré. Une
 * annonce groupée porte tous ses coloris : la retirer parce qu'un seul est
 * épuisé ferait disparaître les seize autres, encore vendables. On ne retire
 * donc que lorsque le produit ENTIER est à zéro — ce qui est aussi la
 * granularité qu'expose `setActive`.
 *
 * LE RETOUR EST AUTOMATIQUE, MAIS SEULEMENT POUR CE QU'ON A RETIRÉ. Sans
 * cette réserve, un réapprovisionnement mettrait en vente des brouillons que
 * personne n'a relus — exactement ce que la création d'annonce refuse de
 * faire. Le drapeau `retireParStock` distingue « retiré par la règle » de
 * « jamais publié » et de « retiré à la main ».
 */

/** Ce que la règle a décidé, pour que l'appelant puisse le dire. */
export interface Disponibilite {
  action: "retire" | "remis" | "rien";
  /** Comptes touchés. Zéro quand rien n'était à faire. */
  comptes: number;
  resultats: TargetResult[];
}

const RIEN: Disponibilite = { action: "rien", comptes: 0, resultats: [] };

/**
 * Aligne les annonces d'un produit sur son stock réel.
 *
 * Ne fait AUCUN appel réseau quand l'état voulu est déjà l'état courant —
 * c'est ce qui permet de l'appeler après chaque écriture de stock sans brûler
 * le quota de sous-requêtes, qui est de cinquante par invocation.
 */
export async function appliquerDisponibilite(
  env: Env,
  productId: string,
  compteur: { used: number } = { used: 0 },
): Promise<Disponibilite> {
  const db = drizzle(env.DB);

  const [p] = await db
    .select({ id: product.id, marketplaceData: product.marketplaceData })
    .from(product)
    .where(eq(product.id, productId))
    .limit(1);
  if (!p) return RIEN;

  /*
   * Le stock DISPONIBLE, pas le stock possédé.
   *
   * Ce qui est réservé pour une commande en cours de préparation ne peut plus
   * être vendu : le compter ferait garder en ligne une annonce dont la
   * marchandise est déjà promise.
   */
  const [somme] = await db
    .select({
      dispo: sql<number>`coalesce(sum(max(${inventory.onHand} - ${inventory.reserved}, 0)), 0)`,
    })
    .from(variant)
    .leftJoin(inventory, eq(inventory.variantId, variant.id))
    .where(and(eq(variant.productId, productId), eq(variant.status, "active")));

  const disponible = Number(somme?.dispo ?? 0);

  let donnees: Record<string, unknown> = {};
  try {
    donnees = JSON.parse(p.marketplaceData ?? "{}") as Record<string, unknown>;
  } catch {
    // Une donnée illisible ne doit pas empêcher la règle de s'appliquer.
  }
  const dejaRetire = donnees["retireParStock"] === true;

  const doitEtreRetire = disponible === 0;
  // L'état voulu est déjà l'état courant : rien à écrire, rien à appeler.
  if (doitEtreRetire === dejaRetire) return RIEN;

  /*
   * On ne vise que les annonces dans l'état de départ attendu.
   *
   * Pour retirer : celles qui sont ACTIVES. Un brouillon jamais publié n'a
   * rien à retirer, et le lui demander produirait une erreur chez eBay, dont
   * l'API refuse de retirer une offre non publiée.
   *
   * Pour remettre : celles qui sont INACTIVES — c'est-à-dire précisément
   * celles que la règle avait couchées.
   */
  const etatAttendu = doitEtreRetire ? "active" : "inactive";
  const comptes = await db
    .selectDistinct({ shopId: listing.shopId })
    .from(listing)
    .innerJoin(shop, eq(shop.id, listing.shopId))
    .where(
      and(
        eq(listing.productId, productId),
        eq(listing.status, etatAttendu),
        eq(shop.status, "active"),
      ),
    );

  if (comptes.length === 0) {
    /*
     * Aucune annonce à basculer, mais l'état a bel et bien changé. On mémorise
     * quand même : sans ça, un produit épuisé AVANT d'être publié ne serait
     * jamais reconnu comme retiré, et son réapprovisionnement n'activerait
     * rien. Le drapeau décrit l'intention, pas le nombre d'appels réussis.
     */
    await memoriser(env, productId, donnees, doitEtreRetire);
    return { action: doitEtreRetire ? "retire" : "remis", comptes: 0, resultats: [] };
  }

  const mod = buildEngine(env, compteur);
  const outcome = await mod.orchestrator.setActive({
    productId,
    accountIds: comptes.map((c) => c.shopId),
    active: !doitEtreRetire,
    idempotencyKey: `dispo:${productId}:${doitEtreRetire ? "off" : "on"}:${disponible}`,
  });

  /*
   * Le drapeau ne se pose que si AU MOINS UNE plateforme a suivi.
   *
   * Le poser sur un échec complet mentirait deux fois : l'annonce resterait
   * en vente, et le réapprovisionnement croirait avoir à la « remettre »,
   * donc n'y toucherait pas. Mieux vaut retenter au passage suivant.
   */
  if (outcome.anySuccess) {
    await memoriser(env, productId, donnees, doitEtreRetire);
  }

  return {
    action: doitEtreRetire ? "retire" : "remis",
    comptes: comptes.length,
    resultats: outcome.results,
  };
}

async function memoriser(
  env: Env,
  productId: string,
  donnees: Record<string, unknown>,
  retire: boolean,
): Promise<void> {
  const db = drizzle(env.DB);
  const suite = { ...donnees };
  if (retire) suite["retireParStock"] = true;
  else delete suite["retireParStock"];

  await db
    .update(product)
    .set({
      marketplaceData: JSON.stringify(suite),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(product.id, productId));
}

/**
 * Retire les annonces d'un produit sur toutes les boutiques, sans condition.
 *
 * Sert avant une suppression : effacer un produit dont les annonces restent en
 * vente laisserait des articles achetables que plus rien ne suit. Pire, la
 * synchronisation les retrouverait au passage suivant et recréerait un
 * produit — la suppression n'aurait servi qu'à perdre le coût d'achat et les
 * déclarations obligatoires.
 */
export async function retirerPartout(
  env: Env,
  productId: string,
  compteur: { used: number } = { used: 0 },
): Promise<{ comptes: number; resultats: TargetResult[] }> {
  const db = drizzle(env.DB);

  const comptes = await db
    .selectDistinct({ shopId: listing.shopId })
    .from(listing)
    .innerJoin(shop, eq(shop.id, listing.shopId))
    .where(
      and(
        eq(listing.productId, productId),
        eq(listing.status, "active"),
        eq(shop.status, "active"),
      ),
    );

  if (comptes.length === 0) return { comptes: 0, resultats: [] };

  const mod = buildEngine(env, compteur);
  const outcome = await mod.orchestrator.setActive({
    productId,
    accountIds: comptes.map((c) => c.shopId),
    active: false,
    idempotencyKey: `suppression:${productId}`,
  });

  return { comptes: comptes.length, resultats: outcome.results };
}
