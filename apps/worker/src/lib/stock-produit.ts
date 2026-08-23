import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { inventory, product, variant } from "../db/schema.js";

/**
 * Recalcule le stock affiché d'un produit depuis ses variantes.
 *
 * `product.stock` N'EST PAS une source de vérité — le stock vit sur la
 * variante depuis que le modèle sait qu'un article existe en plusieurs
 * coloris. Cette colonne est un RÉSUMÉ, entretenu pour les écrans qui
 * raisonnent au niveau du produit : la liste du stock, la fiche de diffusion,
 * le panel d'IA.
 *
 * Faute de l'entretenir, elle a divergé : la synchronisation écrivait zéro à
 * la création du produit maître et ne le corrigeait jamais. Quatre produits
 * sur six affichaient « 0 » avec 207 unités réellement en stock — un chiffre
 * faux est pire qu'un chiffre absent, parce qu'on le croit.
 *
 * Les variantes archivées sont exclues : la plateforme ne les renvoie plus,
 * les compter gonflerait un stock qui n'existe pas.
 */
export async function recalculerStockProduit(
  db: DrizzleD1Database,
  productId: string,
): Promise<void> {
  const [somme] = await db
    .select({
      unites: sql<number>`coalesce(sum(${inventory.onHand}), 0)`,
      combien: sql<number>`count(${variant.id})`,
    })
    .from(variant)
    .leftJoin(inventory, eq(inventory.variantId, variant.id))
    .where(and(eq(variant.productId, productId), eq(variant.status, "active")));

  await db
    .update(product)
    .set({
      stock: Number(somme?.unites ?? 0),
      variantCount: Number(somme?.combien ?? 0),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(product.id, productId));
}
