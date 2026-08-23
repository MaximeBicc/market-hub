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

/**
 * L'identité d'une déclinaison, indépendante de sa graphie.
 *
 * « Bleu Marine », « bleu marine » et « Bleu  Marine » désignent le même
 * coloris ; sans mise à plat, la synchronisation en créerait trois et le
 * stock se répartirait entre des jumeaux.
 *
 * Cette règle est partagée entre la synchronisation et la saisie manuelle À
 * DESSEIN : deux copies qui divergent d'un espace feraient qu'un coloris
 * saisi à la main ne serait plus reconnu comme celui de la boutique.
 */
export function normaliserValeur(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}
