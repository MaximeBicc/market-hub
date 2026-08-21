import type { Evidence, Skill } from "../domain/types.js";
import { relativeGap, spread } from "../tools/economics.js";
import { ratio, stringList } from "../lib/json.js";
import { JSON_HINT, SYSTEM_RULES } from "./shared.js";

export interface MarketResearchInput {
  productId: string;
  /** Requête libre. Sinon, construite depuis le titre du produit. */
  query?: string;
  /** Marchés visés, en clair. « France », « Allemagne ». */
  markets?: string[];
  forceFresh?: boolean;
}

/** Une observation telle qu'elle est montrée : sourcée, datée, convertie. */
export interface Observation {
  url: string;
  titre: string | null;
  /** Centimes d'euro, après conversion BCE. Null si non convertible. */
  prixEur: number | null;
  /** Prix et devise d'origine, conservés : c'est ce que la page affichait. */
  prixOrigine: number | null;
  devise: string | null;
  source: Evidence["kind"];
  observeLe: string;
  fiabilite: number;
  note: string | null;
  /** Photo du produit, tirée des métadonnées de la page. */
  image: string | null;
  /** Ventes affichées par la page. Null quand elle n'en publie pas. */
  ventes: number | null;
}

/**
 * Ce que le marché vend, et pas seulement à quel prix.
 *
 * Le volume corrige la lecture des prix : un concurrent à 3 € qui a vendu deux
 * fois ne pèse rien, un autre à 12 € qui en a vendu mille dit où est le
 * marché. Sans cette colonne, une médiane traite les deux à égalité.
 */
export interface VolumeMarche {
  /** Offres dont la page publiait un nombre de ventes. */
  offresRenseignees: number;
  totalVentes: number;
  /** L'offre la plus vendue parmi celles qui le disent. */
  meilleureVente: { url: string; ventes: number; prixEur: number | null } | null;
}

export interface MarketResearchOutput {
  produit: { sku: string; titre: string };
  requete: string;
  observations: Observation[];
  /** Statistiques sur les seuls prix convertibles. Null si moins de deux. */
  marche: ReturnType<typeof spread>;
  volume: VolumeMarche;
  notre: { prixMedianEur: number | null; ecartAuMarche: number | null };
  lecture: {
    position: "au-dessus" | "dans le marché" | "en dessous" | "indéterminée";
    resume: string;
    confidence: number;
  };
  /** Couches interrogées, quota web entamé ou non, taux appliqués. */
  provenance: {
    couches: string[];
    rechercheWebUtilisee: boolean;
    tauxPublicsDu: string | null;
    cache: boolean;
  };
  avertissements: string[];
}

/**
 * Prix du marché.
 *
 * CE QUE CETTE SKILL APPORTE que `product.price.recommend` ne peut pas : un
 * point de comparaison EXTÉRIEUR. La recommandation de prix ne raisonne que sur
 * nos propres chiffres — elle sait si l'on gagne de l'argent, pas si l'on est
 * cher.
 *
 * Toute observation affichée porte son URL, sa date et sa devise d'origine. La
 * conversion en euros est faite en TypeScript sur les taux BCE, jamais par le
 * modèle : c'est le calcul le plus facile à rater et le plus difficile à
 * repérer une fois raté.
 *
 * Le modèle n'intervient qu'à la toute fin, et pour une seule chose : dire ce
 * que la comparaison signifie. Il ne collecte pas, ne convertit pas, ne calcule
 * pas la médiane.
 */
export const marketResearch: Skill<MarketResearchInput, MarketResearchOutput> = {
  name: "market.price.research",
  version: "1.0.0",
  description: "Cherche à quel prix ce produit se vend ailleurs, avec la source et la date de chaque prix.",
  // Requête et prix publics : rien d'interne ne part dans la recherche.
  dataClass: "public",
  impact: "medium",
  // Deux heures seulement : le moteur de recherche a son propre cache de six
  // heures sur les preuves. Celui-ci ne couvre que la mise en forme et la
  // lecture, qu'on veut pouvoir rafraîchir sans redépenser du quota web.
  cacheTtl: 2 * 60 * 60,

  /**
   * Une recherche qui n'a rien situé expire en cinq minutes.
   *
   * Les causes d'un tel vide sont presque toujours réparables sur-le-champ :
   * clé Gemini absente, API Google non activée, requête trop vague. Garder ce
   * vide deux heures, c'est faire croire que la correction n'a servi à rien.
   */
  cacheTtlFor(result) {
    return result.marche === null ? 5 * 60 : 2 * 60 * 60;
  },

  async execute(input, ctx) {
    const product = await ctx.catalogue.product(input.productId);
    if (!product) throw new Error(`PRODUIT_INTROUVABLE:${input.productId}`);

    const requete = input.query?.trim() || product.title;

    const recherche = await ctx.research({
      query: requete,
      direction: "revente",
      product,
      ...(input.markets === undefined ? {} : { markets: input.markets }),
      ...(input.forceFresh === undefined ? {} : { forceFresh: input.forceFresh }),
      maxSources: 14,
    });

    // Les prix du marché excluent les nôtres : se comparer à soi-même ne dit
    // rien, et nos deux annonces tireraient la médiane vers notre propre prix.
    const externes = recherche.evidence.filter((e) => e.kind !== "internal");
    const marche = spread(
      externes.map((e) => e.priceEur).filter((p): p is number => typeof p === "number"),
    );

    const notreMedian = spread(product.listings.map((l) => l.price));
    const ecart =
      marche && notreMedian ? relativeGap(notreMedian.median, marche.median) : null;

    const observations: Observation[] = recherche.evidence.map((e) => ({
      url: e.url,
      titre: e.title ?? null,
      prixEur: e.priceEur,
      prixOrigine: e.price ?? null,
      devise: e.currency ?? null,
      source: e.kind,
      observeLe: e.observedAt,
      fiabilite: Math.round(e.reliability * 100) / 100,
      note: e.snippet ?? null,
      image: e.imageUrls?.[0] ?? null,
      ventes: e.salesCount ?? null,
    }));

    // Le volume ne porte que sur les offres extérieures : nos propres ventes
    // sont déjà connues ailleurs, et les mêler fausserait la comparaison.
    const avecVentes = externes.filter(
      (e): e is typeof e & { salesCount: number } => typeof e.salesCount === "number",
    );
    const meilleure = avecVentes.reduce<(typeof avecVentes)[number] | null>(
      (best, e) => (best === null || e.salesCount > best.salesCount ? e : best),
      null,
    );
    const volume: VolumeMarche = {
      offresRenseignees: avecVentes.length,
      totalVentes: avecVentes.reduce((t, e) => t + e.salesCount, 0),
      meilleureVente: meilleure
        ? { url: meilleure.url, ventes: meilleure.salesCount, prixEur: meilleure.priceEur }
        : null,
    };

    const provenance = {
      couches: recherche.layers,
      rechercheWebUtilisee: recherche.webSearchUsed,
      tauxPublicsDu: recherche.fxPublishedOn,
      cache: recherche.cacheHit,
    };

    // Sans prix de marché, il n'y a rien à interpréter — et rien ne justifie
    // de dépenser un appel de modèle pour le dire.
    if (!marche || marche.count < 2) {
      return {
        produit: { sku: product.sku, titre: product.title },
        requete,
        observations,
        marche,
        volume,
        notre: {
          prixMedianEur: notreMedian?.median ?? null,
          ecartAuMarche: null,
        },
        lecture: {
          position: "indéterminée" as const,
          resume:
            "Pas assez de prix comparables trouvés pour situer le produit. Aucun modèle n'a été appelé.",
          confidence: 0,
        },
        provenance,
        avertissements: recherche.warnings,
      };
    }

    const result = await ctx.run({
      capabilities: ["structured", "reasoning"],
      dataClass: "public",
      impact: "medium",
      hint: "balanced",
      json: true,
      temperature: 0.1,
      maxOutputTokens: 1_400,
      messages: [
        {
          role: "system",
          content: `${SYSTEM_RULES}

Tu situes un produit par rapport aux prix observés sur le marché. Les prix sont déjà convertis en euros et la médiane est déjà calculée : tu ne recalcules rien.
Tu tiens compte de la fiabilité de chaque observation : un prix vu sur une page produit vaut mieux qu'un extrait de résultat de recherche.
Quand des volumes de vente sont fournis, ils comptent plus que les prix seuls : une offre chère qui se vend beaucoup situe le marché mieux qu'une offre bon marché que personne n'achète.
Si les observations te semblent porter sur des produits différents du nôtre, dis-le plutôt que de conclure.
${JSON_HINT('{"position":"au-dessus"|"dans le marché"|"en dessous"|"indéterminée","resume":string,"reserves":string[],"confidence":number}')}
« resume » fait trois phrases au plus. « reserves » liste ce qui fragilise la comparaison : peu d'observations, produits peut-être différents, sources faibles.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            notreProduit: {
              titre: product.title,
              prixMedianCentimes: notreMedian?.median ?? null,
              canaux: product.listings.length,
            },
            marcheCentimesEur: marche,
            volumeDeVentes: volume,
            ecartRelatif: ecart,
            observations: externes.map((e) => ({
              titre: e.title,
              prixEur: e.priceEur,
              source: e.kind,
              fiabilite: Math.round(e.reliability * 100) / 100,
              note: e.snippet,
            })),
          }),
        },
      ],
    });

    const parsed = (result.parsed ?? {}) as Record<string, unknown>;
    const positions = ["au-dessus", "dans le marché", "en dessous", "indéterminée"] as const;
    const position = positions.includes(parsed["position"] as (typeof positions)[number])
      ? (parsed["position"] as (typeof positions)[number])
      : "indéterminée";

    return {
      produit: { sku: product.sku, titre: product.title },
      requete,
      observations,
      marche,
      volume,
      notre: {
        prixMedianEur: notreMedian?.median ?? null,
        ecartAuMarche: ecart,
      },
      lecture: {
        position,
        resume:
          typeof parsed["resume"] === "string" ? parsed["resume"] : "Lecture indisponible.",
        confidence: ratio(parsed["confidence"]),
      },
      provenance,
      avertissements: [...recherche.warnings, ...stringList(parsed["reserves"], 4)],
    };
  },
};
