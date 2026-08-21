import type { Evidence } from "../../domain/types.js";
import type { ResearchRequest, SourcePort } from "../ports.js";

/**
 * TAVILY — la recherche web du panel, sans carte bancaire.
 *
 * POURQUOI PAS GOOGLE. L'ancrage Google Search de Gemini offre 5 000
 * recherches mensuelles, mais elles ne sont accordées qu'aux projets ayant
 * activé la facturation. Éprouvé sur le compte réel le 21 août 2026 : la clé
 * Gemini génère parfaitement du texte, et le même modèle avec l'outil de
 * recherche répond 429 avec un quota de zéro. Aucune ligne de code ne répare
 * cela — seule une carte bancaire le débloque, ce qui sort du cadre du projet.
 *
 * Comparé aux autres sur leurs conditions réelles, pas sur leur page
 * d'accueil : Brave impose une carte même sur son offre gratuite ; Serper
 * offre 2 500 requêtes mais une seule fois, sans renouvellement ; Tavily rend
 * 1 000 crédits CHAQUE mois, sans carte.
 *
 * UNE VIGILANCE. Tavily facture le dépassement à 0,008 $ le crédit au lieu de
 * couper. Sans carte au dossier il ne peut rien prélever, mais on ne s'appuie
 * pas là-dessus : le compteur mensuel arrête à 900 sur 1 000. La gratuité ne
 * doit jamais dépendre de l'incapacité technique d'un fournisseur à encaisser.
 *
 * CE QUE CETTE SOURCE FAIT, ET NE FAIT PAS. Elle rapporte des pages : titre,
 * URL, extrait. Elle n'extrait aucun prix — c'est un modèle qui s'en chargera
 * ensuite, sur du contenu public, donc sur l'allocation Cloudflare qui est
 * gratuite et abondante. Séparer les deux est un gain : la recherche, rare et
 * comptée, ne sert qu'à trouver les pages ; la lecture, fréquente et bon
 * marché, en tire les chiffres.
 */

const ENDPOINT = "https://api.tavily.com/search";

/** Plafond mensuel retenu, sous les 1 000 crédits offerts. */
export const TAVILY_PAR_MOIS = 900;

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

export interface TavilyDeps {
  apiKey: string | undefined;
  /** Recherches déjà passées ce mois-ci. Le port refuse au-delà du plafond. */
  usedThisMonth: () => Promise<number>;
  /** Appelé après chaque recherche réussie, pour tenir le compte. */
  record: () => Promise<void>;
  now: () => number;
  plafond?: number | undefined;
}

export function tavilySource(deps: TavilyDeps): SourcePort {
  return {
    id: "tavily",
    layer: "public",

    async available() {
      if (!deps.apiKey) return false;
      // Le plafond est vérifié AVANT l'appel, pas après : un dépassement est
      // facturé, il ne suffit donc pas de le constater.
      return (await deps.usedThisMonth()) < (deps.plafond ?? TAVILY_PAR_MOIS);
    },

    async search(request: ResearchRequest): Promise<Evidence[]> {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({
          query: construireRequete(request),
          // « basic » coûte un crédit, « advanced » en coûte deux pour une
          // profondeur dont on n'a pas besoin : on cherche des pages produit,
          // pas une synthèse.
          search_depth: "basic",
          max_results: 10,
          // On ne demande PAS de réponse rédigée. Tavily sait en produire une,
          // mais elle serait un résumé sans source vérifiable — exactement ce
          // que le panel refuse d'afficher.
          include_answer: false,
          include_raw_content: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`tavily ${response.status} ${(await response.text()).slice(0, 200)}`);
      }

      await deps.record();

      const data = (await response.json()) as { results?: TavilyResult[] };
      const observedAt = new Date(deps.now()).toISOString();

      return (data.results ?? [])
        .filter((r): r is TavilyResult & { url: string } => typeof r.url === "string")
        .map((r) => ({
          url: r.url,
          title: r.title,
          // « page » et non « search » : Tavily lit la page et en rend un
          // extrait, là où un résultat de moteur ne rend qu'un titre.
          kind: "page" as const,
          observedAt,
          snippet: r.content?.slice(0, 400),
          // AUCUN PRIX ICI, volontairement. Tavily ne les extrait pas, et
          // deviner un prix depuis un extrait produirait exactement le genre
          // de chiffre sans source que le panel existe pour éviter.
          price: null,
          currency: null,
        }));
    },
  };
}

/**
 * Formule la requête envoyée au moteur.
 *
 * Le sens de la recherche change les mots : chercher où ACHETER et chercher à
 * quel prix REVENDRE interrogent des marchés opposés. Sans cette distinction,
 * on compare un prix de gros à un prix de détail et l'on croit avoir trouvé
 * une marge.
 */
function construireRequete(request: ResearchRequest): string {
  const marches = request.markets?.length ? request.markets.join(" ") : "France";
  const intention =
    request.direction === "approvisionnement" ? "fournisseur grossiste prix unitaire" : "prix acheter";

  return `${request.query} ${intention} ${marches}`.slice(0, 380);
}
