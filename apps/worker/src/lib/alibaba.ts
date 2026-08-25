import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { signRequest } from "@hub/connectors";
import { shop } from "../db/schema.js";
import type { Env } from "../env.js";
import type { RateLimiter } from "../do/rate-limiter.js";
import { getValidAccessToken } from "./tokens.js";
import { normaliserValeur } from "./variantes.js";

/**
 * La fiche d'un produit fournisseur, telle qu'on la veut chez nous.
 *
 * Alibaba rend beaucoup, dans une forme qui lui est propre : des montants qui
 * sont des totaux de commande, une description en HTML décoré, des attributs
 * éclatés. Ce module fait la traduction une fois, ici, pour que le reste du
 * système ne voie jamais ces particularités.
 */
export interface DeclinaisonAlibaba {
  skuId: string;
  /** « Blanc · 40oz » — lisible, composé des valeurs d'attributs. */
  nom: string;
  optionValues: string[];
  /** « couleur=blanc|capacite=40oz », au format qu'écrit la synchronisation. */
  optionKey: string;
  image: string | null;
  /** Prix fournisseur à la pièce, en centimes, au premier palier. */
  prixPalier: number | null;
  /** Coût débarqué à la pièce — marchandise ET fret — en centimes. */
  coutDebarque: number | null;
}

export interface FicheAlibaba {
  productId: string;
  titre: string;
  description: string;
  categorie: string | null;
  fournisseur: string | null;
  lien: string | null;
  devise: string;
  quantiteMinimale: number;
  images: string[];
  axes: string[];
  declinaisons: DeclinaisonAlibaba[];
  /** Le coût débarqué du premier coloris, à défaut de mieux. */
  coutDebarqueUnitaire: number | null;
}

/**
 * L'identifiant produit, lu dans un lien collé ou donné seul.
 *
 * Les adresses Alibaba le portent en fin de chemin, précédé d'un tiret bas :
 * `.../product-detail/Sublimation-Mug_1601206892606.html`. Coller l'adresse de
 * la page est le geste naturel — exiger l'identifiant nu obligerait à aller le
 * chercher dans l'URL à la main.
 */
export function idDepuisLien(texte: string): string | null {
  const t = (texte ?? "").trim();
  if (!t) return null;

  // Rien qu'un nombre : c'est l'identifiant, donné directement.
  if (/^\d+$/.test(t)) return t;

  /*
   * L'IDENTIFIANT EST CELUI QUI PRÉCÈDE « .html », ET LUI SEUL.
   *
   * La première version prenait le dernier nombre long de la chaîne. Ça
   * marchait sur une adresse propre et se trompait sur toutes les autres :
   * les liens reçus par courriel traînent des paramètres de suivi qui sont
   * eux aussi des nombres longs. Sur
   *
   *   .../Luxury-Clear-Magnetic-Case-for-iPhone_1601369397918.html
   *      ?crm_mtn_tracelog_log_id=147046631551&t_id=2000114762&...
   *
   * la règle « le dernier » rendait 2000114762 — un identifiant de campagne.
   * Alibaba répondait alors qu'il ne connaît pas ce produit, ce qui était
   * exact et incompréhensible.
   */
  const chemin = t.split("?")[0] ?? t;
  const avantHtml = chemin.match(/_(\d{6,})\.html?$/i);
  if (avantHtml) return avantHtml[1]!;

  // Adresse sans extension : le dernier nombre long DU CHEMIN, jamais de la
  // chaîne de requête — c'est elle qui porte les paramètres de suivi.
  const dansChemin = chemin.match(/\d{10,}/g);
  if (dansChemin) return dansChemin[dansChemin.length - 1]!;

  return null;
}

/**
 * La description, débarrassée de la décoration d'Alibaba.
 *
 * Elle arrive en HTML avec ses propres feuilles de style et un balisage
 * maison (`magic-0`, `detail_decorate_root`). Etsy et eBay ne l'accepteraient
 * pas telle quelle, et un vendeur ne veut pas relire ça. On garde le TEXTE —
 * le tableau de caractéristiques y survit, ligne par ligne — et on jette la
 * mise en forme.
 */
export function nettoyerDescription(html: string): string {
  if (!html) return "";
  return (
    html
      // Les styles et scripts d'abord : leur CONTENU ne doit pas survivre à
      // l'effacement des balises, sinon on garderait le CSS en clair.
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      // Les fins de ligne structurantes deviennent de vraies fins de ligne.
      .replace(/<\/(tr|p|div|h[1-6]|li)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      // Les cellules d'un même tableau se séparent d'un tiret, pour que
      // « Capacité | 40oz » reste lisible une fois les balises parties.
      .replace(/<\/t[dh]>/gi, " : ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&eacute;/g, "é")
      .replace(/&egrave;/g, "è")
      .replace(/&agrave;/g, "à")
      .replace(/&ccedil;/g, "ç")
      .replace(/&ocirc;/g, "ô")
      .replace(/&ecirc;/g, "ê")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n")
      .trim()
      // Etsy plafonne la description ; au-delà, on tronque proprement plutôt
      // que de se faire refuser l'annonce.
      .slice(0, 5000)
  );
}

/** Euros décimaux vers centimes entiers, en refusant ce qui n'est pas un nombre. */
function centimes(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

interface SkuAlibaba {
  sku_id?: number;
  image?: string;
  cost_origin_price?: number | string;
  total_origin_cost_price?: number | string;
  shipping_fee?: number | string;
  status?: string;
  sku_attr_list?: Array<{
    attr_name_desc?: string;
    attr_value_desc?: string;
    attr_value_image?: string;
  }>;
  ladder_price?: Array<{ min_quantity?: number; price?: number }>;
}

/**
 * Interroge Alibaba et rend la fiche traduite.
 *
 * Trois choses que cette fonction sait et que ses appelants ignorent :
 *
 *   - l'API répond en GET, pas en POST comme la liste des commandes ;
 *   - `query_req` est un OBJET, envoyé en JSON dans son champ ;
 *   - `ship_to_country` conditionne le calcul du fret. L'omettre donnerait un
 *     coût calculé pour un autre pays — donc une marge fausse.
 */
export async function ficheProduit(
  env: Env,
  productId: string,
): Promise<FicheAlibaba> {
  const db = drizzle(env.DB);
  const [boutique] = await db
    .select({ id: shop.id })
    .from(shop)
    .where(eq(shop.platform, "alibaba"))
    .limit(1);
  if (!boutique) {
    throw new Error(
      "Aucun compte Alibaba connecté. Reliez-le d'abord dans les boutiques.",
    );
  }

  const stub = env.RATE_LIMITER.get(
    env.RATE_LIMITER.idFromName(boutique.id),
  ) as DurableObjectStub<RateLimiter>;
  const { accessToken } = await getValidAccessToken(env, boutique.id, stub);

  const chemin = "/eco/buyer/product/description";
  const parametres: Record<string, string> = {
    app_key: env.ALIBABA_APP_KEY,
    timestamp: String(Date.now()),
    sign_method: "sha256",
    access_token: accessToken,
    query_req: JSON.stringify({
      product_id: Number(productId),
      country: "FR",
      language: "fr-FR",
      currency: "EUR",
      ship_to_country: "FR",
    }),
  };
  parametres["sign"] = await signRequest(
    chemin,
    parametres,
    env.ALIBABA_APP_SECRET,
  );

  const reponse = await fetch(
    `https://openapi-api.alibaba.com/rest${chemin}?${new URLSearchParams(parametres)}`,
    { method: "GET" },
  );
  const texte = await reponse.text();

  let j: {
    result?: {
      result_data?: Record<string, unknown>;
      result_msg?: string;
      result_code?: string | number;
    };
    code?: string;
    message?: string;
  };
  try {
    j = JSON.parse(texte);
  } catch {
    throw new Error(`Réponse illisible d'Alibaba : ${texte.slice(0, 200)}`);
  }

  // La passerelle répond 200 même sur refus : c'est le corps qui tranche.
  if (j.code && j.code !== "0") {
    throw new Error(`Alibaba ${j.code} : ${j.message ?? "sans détail"}`);
  }

  const d = j.result?.result_data;
  if (!d) {
    throw new Error(
      j.result?.result_msg
        ? `Alibaba : ${j.result.result_msg}`
        : "Alibaba n'a rendu aucune fiche pour ce produit.",
    );
  }

  const qmin = Math.max(1, Number(d["min_order_quantity"] ?? 1));
  const skus = (d["skus"] as SkuAlibaba[] | undefined) ?? [];

  /*
   * LES AXES, DANS L'ORDRE OÙ ALIBABA LES PRÉSENTE.
   *
   * Un produit peut en avoir plusieurs — « Couleur » ET « Capacité ». Les
   * réduire à un seul fondrait deux coloris de contenances différentes en une
   * même déclinaison, et leurs stocks avec.
   */
  const axes: string[] = [];
  for (const sku of skus) {
    for (const a of sku.sku_attr_list ?? []) {
      const nom = (a.attr_name_desc ?? "").trim();
      if (nom && !axes.includes(nom)) axes.push(nom);
    }
  }

  const declinaisons: DeclinaisonAlibaba[] = skus
    .filter((sku) => sku.status !== "DELETE")
    .map((sku) => {
      const attrs = sku.sku_attr_list ?? [];
      const valeurs = axes.map(
        (axe) =>
          attrs.find((a) => (a.attr_name_desc ?? "").trim() === axe)
            ?.attr_value_desc ?? "",
      );

      /*
       * Les montants d'Alibaba sont des TOTAUX pour la quantité minimale.
       * `ladder_price` annonce 2,56 € la pièce à partir de 500, et
       * `cost_origin_price` vaut 1277,47 € — soit 500 × 2,56. Les prendre
       * pour des prix unitaires afficherait un coût cinq cents fois trop
       * élevé, et une marge absurde.
       */
      const debarqueTotal = Number(sku.total_origin_cost_price);
      const coutDebarque = Number.isFinite(debarqueTotal)
        ? Math.round((debarqueTotal / qmin) * 100)
        : null;

      // Le palier le plus bas en quantité : c'est celui qu'on paiera en
      // commandant le minimum.
      const paliers = [...(sku.ladder_price ?? [])].sort(
        (x, y) => Number(x.min_quantity ?? 0) - Number(y.min_quantity ?? 0),
      );

      const image =
        sku.image ||
        attrs.find((a) => a.attr_value_image)?.attr_value_image ||
        null;

      return {
        skuId: String(sku.sku_id ?? ""),
        nom: valeurs.filter(Boolean).join(" · ") || "sans déclinaison",
        optionValues: valeurs,
        optionKey: axes
          .map((axe, i) => `${normaliserValeur(axe)}=${normaliserValeur(valeurs[i] ?? "")}`)
          .join("|"),
        // Les vignettes d'attribut arrivent en `_100x100` — minuscules. La
        // version pleine est la même adresse sans ce suffixe.
        image: image ? image.replace(/_\d+x\d+\.jpg$/i, "") : null,
        prixPalier: centimes(paliers[0]?.price),
        coutDebarque,
      };
    });

  return {
    productId,
    titre: String(d["title"] ?? "").slice(0, 200),
    description: nettoyerDescription(String(d["description"] ?? "")),
    categorie: (d["category"] as string) ?? null,
    fournisseur: (d["supplier"] as string) ?? null,
    lien: (d["detail_url"] as string) ?? null,
    devise: String(d["currency"] ?? "EUR"),
    quantiteMinimale: qmin,
    images: ((d["images"] as string[] | undefined) ?? []).filter(Boolean),
    axes,
    declinaisons,
    coutDebarqueUnitaire: declinaisons[0]?.coutDebarque ?? null,
  };
}
