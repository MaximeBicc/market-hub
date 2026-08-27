import { describe, expect, it } from "vitest";
import {
  coutGroupe,
  coutQuotidien,
  decouperEnLots,
  planReleves,
} from "./releves.js";
import { ShopifyAdapter } from "../adapters/shopify.js";
import { EtsyAdapter } from "../adapters/etsy.js";
import { EbayAdapter } from "../adapters/ebay.js";
import { AlibabaAdapter } from "../adapters/alibaba.js";
import type { MarketplaceContext } from "../ports/marketplace.js";

/**
 * SIMULATION DE LA CONSOMMATION, AVANT ET APRÈS.
 *
 * Ces chiffres décident si l'outil tient ou s'arrête. Les vérifier ici plutôt
 * que de les recalculer à la main évite qu'un changement de cadence passe
 * inaperçu — une constante déplacée de 900 à 300 ne casse aucun test
 * fonctionnel, et coûte trois fois plus tous les jours.
 */

function ctx(marketplace: string, credentials: Record<string, string> = {}): MarketplaceContext {
  return {
    account: { id: "c1", marketplace, slug: "c1", displayName: "c1", enabled: true },
    credentials,
  };
}

/** Le quota gratuit de Cloudflare Queues : trois opérations par message. */
const QUOTA_FILE = 10_000;

describe("simulation de la flotte", () => {
  it("l'état d'avant dépassait le quota, Alibaba compris", async () => {
    const shopify = await new ShopifyAdapter().capabilities();
    const ebay = new EbayAdapter().capabilities(ctx("ebay"));
    const etsy = new EtsyAdapter().capabilities(ctx("etsy"));

    /*
     * Alibaba portait trois relevés ACTIFS, créés par un planificateur
     * aveugle aux capacités : commandes toutes les dix minutes, inventaire
     * tous les quarts d'heure, catalogue quotidien. Le coût est reconstitué
     * ici parce que la politique corrigée ne sait plus le produire.
     */
    const alibabaAvant = (144 + 96 + 1) * 3;

    const avant =
      coutQuotidien(planReleves(shopify, false)).operations +
      coutQuotidien(planReleves(ebay, false)).operations +
      coutQuotidien(planReleves(etsy, false)).operations +
      alibabaAvant;

    expect(avant).toBe(13_692);
    expect(avant).toBeGreaterThan(QUOTA_FILE);
  });

  it("un compte d'approvisionnement ne coûte plus rien", async () => {
    const caps = await new AlibabaAdapter().capabilities();
    expect(coutQuotidien(planReleves(caps, true)).operations).toBe(0);
    expect(coutQuotidien(planReleves(caps, false)).operations).toBe(0);
  });

  it("Shopify en temps réel fait repasser la flotte sous le quota", async () => {
    const shopify = await new ShopifyAdapter().capabilities();
    const ebay = new EbayAdapter().capabilities(ctx("ebay"));
    const etsy = new EtsyAdapter().capabilities(ctx("etsy"));

    const apres =
      coutQuotidien(planReleves(shopify, true)).operations +
      coutQuotidien(planReleves(ebay, false)).operations +
      coutQuotidien(planReleves(etsy, false)).operations;

    expect(apres).toBe(9_225);
    expect(apres).toBeLessThan(QUOTA_FILE);
    // Un tiers du coût de départ, pour une fraîcheur MEILLEURE côté Shopify.
    expect(apres / 13_692).toBeLessThan(0.7);
  });

  it("Etsy branché à son tour laisse de la place pour grandir", async () => {
    const shopify = await new ShopifyAdapter().capabilities();
    const ebay = new EbayAdapter().capabilities(ctx("ebay"));
    const etsy = new EtsyAdapter().capabilities(
      ctx("etsy", { webhookSecret: "whsec_x" }),
    );

    const parBoutique =
      coutQuotidien(planReleves(shopify, true)).operations +
      coutQuotidien(planReleves(etsy, true)).operations +
      coutQuotidien(planReleves(ebay, false)).operations;

    expect(parBoutique).toBe(5_481);
    // eBay pèse à lui seul les quatre cinquièmes de ce qui reste : c'est là
    // que le prochain gain se trouve, pas ailleurs.
    expect(coutQuotidien(planReleves(ebay, false)).operations / parBoutique)
      .toBeGreaterThan(0.75);
  });
});

describe("appels eBay par jour", () => {
  /**
   * L'autre plafond, celui qu'on s'impose : 5 000 appels par jour.
   * Il ne se compte pas en opérations de file mais en requêtes vers eBay, et
   * c'est le nombre d'ARTICLES qui le fait exploser — pas le nombre de
   * boutiques.
   */
  const PLAFOND_EBAY = 5_000;

  /** Une page de quinze articles, N+1 compris. */
  const complet = (articles: number) =>
    Math.ceil(articles / 15) + articles;
  /** La même page, quantités seules. */
  const allege = (articles: number) => Math.ceil(articles / 15);

  const parJour = (appelsParPasse: number, intervalSec: number) =>
    appelsParPasse * Math.floor(86_400 / intervalSec);

  it("cinq articles suffisaient à franchir le plafond", () => {
    const inventaire = parJour(complet(5), 120);
    const commandes = parJour(1, 120);
    expect(inventaire + commandes).toBe(5_040);
    expect(inventaire + commandes).toBeGreaterThan(PLAFOND_EBAY);
  });

  it("quinze articles le franchissaient de plus du double", () => {
    expect(parJour(complet(15), 120) + parJour(1, 120)).toBe(12_240);
  });

  it("allégé, cent articles restent au-dessus du plafond à deux minutes", () => {
    const inventaire = parJour(allege(100), 120);
    const commandes = parJour(1, 120);
    // Le catalogue complet garde son N+1, mais une fois par jour seulement.
    const catalogue = complet(100);
    const total = inventaire + commandes + catalogue;

    // 7 pages × 720 passages + 720 commandes + 107 pour le catalogue complet.
    expect(total).toBe(5_867);
    // Encore au-dessus avec cent articles ET aucun webhook : c'est la
    // notification eBay qui reste le vrai levier, pas cette optimisation.
    expect(total).toBeGreaterThan(PLAFOND_EBAY);
  });

  it("allégé ET en filet de quinze minutes, cent articles tiennent largement", () => {
    const total =
      parJour(allege(100), 900) + parJour(1, 900) + complet(100);
    expect(total).toBe(875);
    expect(total).toBeLessThan(PLAFOND_EBAY / 4);
  });
});

describe("regroupement des tâches", () => {
  /**
   * L'économie qui ne dépend d'aucune plateforme, et donc la seule qui agisse
   * quand le quota est déjà épuisé.
   */
  it("découpe sans rien perdre ni dupliquer", () => {
    const taches = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const lots = decouperEnLots(taches, 8);

    expect(lots).toHaveLength(2);
    expect(lots[0]).toHaveLength(8);
    expect(lots[1]).toHaveLength(2);
    // Rien ne se perd, rien ne se répète : c'est la seule chose qui compte.
    expect(lots.flat()).toEqual(taches);
  });

  it("rend un lot vide plutôt qu'un lot de rien", () => {
    expect(decouperEnLots([], 8)).toEqual([]);
  });

  it("refuse une taille absurde au lieu de boucler à l'infini", () => {
    // Une taille nulle ferait tourner la découpe sans jamais avancer.
    expect(() => decouperEnLots([1, 2], 0)).toThrow();
  });

  it("divise la facture par la taille du lot", () => {
    // 193 tâches par boutique et par jour, une fois en temps réel.
    const parBoutique = 193;
    expect(coutGroupe(parBoutique, 1)).toBe(579); // l'état d'avant
    expect(coutGroupe(parBoutique, 8)).toBe(75);
    // Presque huit fois moins, sans toucher à la fraîcheur ni aux quotas des
    // plateformes : c'est de la pure comptabilité Cloudflare.
    expect(coutGroupe(parBoutique, 8) / coutGroupe(parBoutique, 1)).toBeLessThan(0.14);
  });

  it("fait tenir la flotte actuelle très en dessous du quota, sans temps réel", () => {
    /*
     * Le cas qui compte aujourd'hui : le quota est épuisé, et les webhooks
     * Shopify ne sont pas encore activés. Le regroupement agit seul.
     */
    const tachesParBoutique = 1441; // relevé toutes les deux minutes
    const flotte = tachesParBoutique * 3; // Shopify, eBay, Etsy

    expect(coutGroupe(flotte, 1)).toBe(12_969); // au-dessus des 10 000
    const groupe = coutGroupe(flotte, 8);
    expect(groupe).toBe(1_623);
    expect(groupe).toBeLessThan(10_000 / 5);
  });

  it("un report coûte un message, pas une tâche", () => {
    // Sept tâches reportées repartent dans UN lot : trois opérations, pas
    // vingt et une. C'est ce qui rend le report acceptable.
    expect(coutGroupe(7, 8)).toBe(3);
  });
});
