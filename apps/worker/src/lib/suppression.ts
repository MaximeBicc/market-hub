/**
 * LA PIERRE TOMBALE D'UN PRODUIT SUPPRIMÉ.
 *
 * Supprimer un produit du stock n'efface pas son annonce chez la plateforme :
 * elle est retirée de la vente et conservée, parce qu'une annonce ancienne
 * porte ses avis et son référencement — les recréer coûte des mois.
 *
 * Mais l'annonce survivante continue d'être relevée par la synchronisation.
 * Sans marque, le relevé ne retrouve ni produit rattaché ni SKU connu, et
 * RECRÉE un produit maître : le produit supprimé réapparaissait dans le stock
 * à la minute suivante, avec un nouvel identifiant et un SKU « auto:… ». Six
 * produits fantômes ressuscités en une nuit, et une suppression qui ne
 * supprimait rien.
 *
 * La marque vit sur le GROUPE d'annonces — l'objet parent chez la plateforme,
 * c'est-à-dire précisément ce que la personne a décidé de ne plus vendre. Sa
 * clé (boutique, identifiant distant) survit à tout : suppression du produit,
 * relevés, redéploiements.
 *
 * Elle se lève d'elle-même le jour où quelqu'un rattache à nouveau ce groupe à
 * un produit — recréer le produit avec le même SKU suffit. Un geste humain
 * défait ce qu'un geste humain avait fait.
 */

const MARQUE = "supprimeDuStock";

function lire(json: string | null | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(json ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    // Une donnée illisible ne doit pas faire échouer un relevé : on repart
    // d'un objet vide plutôt que de laisser remonter l'exception.
    return {};
  }
}

/** Ce groupe correspond-il à un produit supprimé du stock ? */
export function estSupprime(marketplaceData: string | null | undefined): boolean {
  return lire(marketplaceData)[MARQUE] !== undefined;
}

/** Pose la marque, en conservant le reste des données de plateforme. */
export function marquerSupprime(
  marketplaceData: string | null | undefined,
  quand: number,
): string {
  return JSON.stringify({ ...lire(marketplaceData), [MARQUE]: quand });
}

/** Lève la marque : le groupe est de nouveau rattaché à un produit. */
export function leverMarque(marketplaceData: string | null | undefined): string {
  const suite = lire(marketplaceData);
  delete suite[MARQUE];
  return JSON.stringify(suite);
}
