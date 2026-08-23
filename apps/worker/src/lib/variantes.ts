import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { variant } from "../db/schema.js";

/**
 * La variante « par défaut » d'un produit.
 *
 * Le stock vit sur la VARIANTE depuis que le modèle sait qu'un support
 * téléphone existe en dix-sept coloris. Les écrans et routes qui raisonnent
 * encore au niveau du produit ont besoin d'un point d'entrée : un produit sans
 * déclinaison — le cas de tout ce qui est saisi à la main — n'a qu'une
 * variante, et c'est celle-là.
 *
 * Renvoie `undefined` pour un produit à plusieurs déclinaisons. Là, « le »
 * stock du produit n'existe pas, et en désigner un au hasard serait pire que
 * de refuser : c'est ainsi qu'on décrémente le mauvais coloris.
 */
export async function varianteUnique(
  db: DrizzleD1Database,
  productId: string,
): Promise<string | undefined> {
  const v = await db
    .select({ id: variant.id })
    .from(variant)
    .where(eq(variant.productId, productId))
    .limit(2);
  return v.length === 1 ? v[0]!.id : undefined;
}
