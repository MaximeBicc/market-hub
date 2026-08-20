import type { Evidence, ProductFacts } from "../domain/types.js";

/**
 * Sources de preuves, par couche.
 *
 * L'ordre des couches est un ordre de COÛT autant que de confiance : ce qu'on
 * sait déjà ne coûte rien, ce qu'une API officielle nous donne ne coûte rien
 * non plus, et la recherche web est la seule à consommer un quota limité. On
 * ne descend d'une couche que si la précédente n'a pas suffi.
 */
export type Layer = "interne" | "marketplace" | "fournisseur" | "public";

/**
 * Ce qu'on cherche.
 *
 * `direction` change tout : chercher à quel prix REVENDRE et chercher où
 * ACHETER interrogent des marchés opposés, avec des attentes opposées sur le
 * prix. Les confondre produirait une comparaison entre un prix de gros chinois
 * et un prix de détail français, présentée comme un écart de compétitivité.
 */
export interface ResearchRequest {
  /** Formulation lisible, celle qui partira en recherche web si nécessaire. */
  query: string;
  direction: "revente" | "approvisionnement";
  /** Faits internes, quand la recherche porte sur un produit du catalogue. */
  product?: ProductFacts | undefined;
  /** Pays ou places visés, en clair. « France », « UE », « Alibaba ». */
  markets?: string[] | undefined;
  maxSources?: number | undefined;
  /** Ignore le cache. Réservé à un geste explicite de l'utilisateur. */
  forceFresh?: boolean | undefined;
  /** Vrai pour un travail de cron : budget de recherche réduit. */
  automatic?: boolean | undefined;
}

/**
 * Une source interrogeable.
 *
 * Le panel n'implémente AUCUN client de place de marché : il déclare ce port
 * et le moteur marketplace fournira les adaptateurs. Dupliquer ici un client
 * eBay ou Etsy créerait une seconde vérité sur les mêmes données, et deux
 * endroits où corriger un changement d'API.
 */
export interface SourcePort {
  id: string;
  layer: Layer;
  /** Faux quand la source n'est pas configurée : elle est alors ignorée. */
  available(): boolean | Promise<boolean>;
  search(request: ResearchRequest): Promise<Evidence[]>;
}

/**
 * Registre des sources.
 *
 * Vide au démarrage, et ce n'est pas un oubli : la couche interne est intégrée
 * au moteur, et les couches marketplace et fournisseur attendent que le moteur
 * marketplace expose une recherche publique. Elles s'ajoutent ici sans toucher
 * au moteur de recherche.
 */
export class SourceRegistry {
  private readonly sources: SourcePort[] = [];

  register(source: SourcePort): this {
    this.sources.push(source);
    return this;
  }

  /** Les sources d'une couche, dans l'ordre d'enregistrement. */
  byLayer(layer: Layer): SourcePort[] {
    return this.sources.filter((s) => s.layer === layer);
  }

  all(): SourcePort[] {
    return [...this.sources];
  }
}
