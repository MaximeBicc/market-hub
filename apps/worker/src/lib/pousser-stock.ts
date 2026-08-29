import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { listing, shop, variant } from "../db/schema.js";
import type { Env } from "../env.js";
import { buildEngine } from "../engine/module.js";

/**
 * ÉCRIRE UN STOCK ICI DOIT L'ÉCRIRE PARTOUT.
 *
 * L'outil détient la vérité du stock — c'est la règle du projet. Mais les
 * écrans qui le modifient n'écrivaient qu'en base : la table locale changeait,
 * les annonces gardaient l'ancienne quantité, et rien ne le disait. La
 * correction n'arrivait chez les plateformes qu'au rapprochement suivant, un
 * quart d'heure plus tard — et pendant ce quart d'heure, une boutique pouvait
 * vendre une pièce qui n'existait plus.
 *
 * Ce module fait le trajet tout de suite, et RAPPORTE ce qui s'est passé
 * boutique par boutique. Le compte-rendu compte autant que l'écriture : « stock
 * enregistré » sans dire où laisse croire à une propagation qui n'a peut-être
 * pas eu lieu.
 */

/** Ce qu'une boutique a fait du nouveau stock. */
export interface EtatBoutique {
  nom: string;
  plateforme: string;
  ok: boolean;
  /** Renseigné seulement en cas d'échec : la raison, telle quelle. */
  message?: string;
}

export interface RapportStock {
  boutiques: EtatBoutique[];
  /**
   * Vrai quand toutes les boutiques concernées ont suivi. Une liste vide vaut
   * `true` : un produit qui n'est en vente nulle part n'a rien à propager, et
   * ce n'est pas un échec.
   */
  toutesOk: boolean;
}

/**
 * Le nombre d'écritures qu'une invocation peut porter.
 *
 * Chaque appel consomme des sous-requêtes, et le budget est de cinquante par
 * invocation chez Cloudflare. Une déclinaison sur trois boutiques, c'est trois
 * appels ; dix-sept déclinaisons en feraient cinquante et un. On s'arrête donc
 * avant, et on le DIT : une propagation silencieusement tronquée laisserait
 * des quantités fausses en ligne en affichant « c'est bon ».
 */
const MAX_ECRITURES = 12;

/**
 * Pousse le stock de déclinaisons précises vers toutes les boutiques qui
 * vendent ce produit.
 *
 * `changements` ne contient que ce qui a VRAIMENT changé : propager une valeur
 * identique coûterait le même quota pour ne rien modifier.
 */
export async function pousserStock(
  env: Env,
  productId: string,
  changements: ReadonlyArray<{ variantId: string; stock: number }>,
  compteur: { used: number } = { used: 0 },
): Promise<RapportStock> {
  if (changements.length === 0) return { boutiques: [], toutesOk: true };

  const db = drizzle(env.DB);

  /*
   * Les boutiques qui ont réellement une annonce pour ce produit. Envoyer
   * l'ordre aux autres produirait un « aucune annonce » compté comme échec,
   * et un compte-rendu alarmant pour une situation normale.
   */
  const cibles = await db
    .selectDistinct({ id: shop.id, nom: shop.displayName, plateforme: shop.platform })
    .from(listing)
    .innerJoin(shop, eq(shop.id, listing.shopId))
    .where(and(eq(listing.productId, productId), eq(shop.status, "active")));

  if (cibles.length === 0) return { boutiques: [], toutesOk: true };

  /*
   * Une variante archivée n'est plus en vente : lui pousser un stock ferait
   * ressusciter un coloris retiré, ou échouerait selon la plateforme.
   */
  const vivantes = new Set(
    (
      await db
        .select({ id: variant.id })
        .from(variant)
        .where(
          and(
            eq(variant.productId, productId),
            eq(variant.status, "active"),
            inArray(
              variant.id,
              changements.map((c) => c.variantId),
            ),
          ),
        )
    ).map((v) => v.id),
  );

  const aPousser = changements.filter((c) => vivantes.has(c.variantId));
  if (aPousser.length === 0) return { boutiques: [], toutesOk: true };

  const accountIds = cibles.map((c) => c.id);
  const budget = Math.max(1, Math.floor(MAX_ECRITURES / accountIds.length));
  const retenus = aPousser.slice(0, budget);

  const mod = buildEngine(env, compteur);

  /** Les échecs par boutique. Une boutique qui rate UNE déclinaison a raté. */
  const echecs = new Map<string, string>();

  for (const c of retenus) {
    const outcome = await mod.orchestrator.setStock({
      productId,
      variantId: c.variantId,
      accountIds,
      stock: c.stock,
      /*
       * La clé porte la variante ET la quantité : deux corrections
       * successives vers la même valeur seraient à juste titre ignorées,
       * mais 12 puis 20 puis 12 doivent bien produire trois écritures.
       */
      idempotencyKey: `stock:${productId}:${c.variantId}:${c.stock}`,
    });

    for (const r of outcome.results) {
      if (r.status === "success" || r.status === "unsupported") continue;
      if (!echecs.has(r.accountId)) {
        echecs.set(r.accountId, r.message ?? "raison inconnue");
      }
    }
  }

  const boutiques: EtatBoutique[] = cibles.map((c) => {
    const raison = echecs.get(c.id);
    return {
      nom: c.nom,
      plateforme: c.plateforme,
      ok: !raison,
      ...(raison ? { message: raison } : {}),
    };
  });

  return {
    boutiques,
    toutesOk: boutiques.every((b) => b.ok) && retenus.length === aPousser.length,
  };
}
