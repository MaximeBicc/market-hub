import { describe, expect, it } from "vitest";
import { coutQuotidien, planReleves } from "./releves.js";
import { AlibabaAdapter } from "../adapters/alibaba.js";
import { ShopifyAdapter } from "../adapters/shopify.js";
import { EtsyAdapter } from "../adapters/etsy.js";
import { EbayAdapter } from "../adapters/ebay.js";
import type { MarketplaceContext } from "../ports/marketplace.js";

/**
 * Cette politique décide de la consommation quotidienne de l'outil. Une
 * erreur ici ne casse rien de visible : elle se paie en quota, et se découvre
 * le jour où la synchronisation s'arrête faute d'opérations de file.
 *
 * Les tests partent des capacités RÉELLES des adaptateurs, pas d'objets
 * fabriqués : c'est le désaccord entre les deux qui avait laissé trois
 * relevés actifs sur un compte qui ne vend rien.
 */

function ctx(marketplace: string, credentials: Record<string, string> = {}): MarketplaceContext {
  return {
    account: {
      id: "c1",
      marketplace,
      slug: "c1",
      displayName: "c1",
      enabled: true,
    },
    credentials,
  };
}

describe("politique de relevé", () => {
  it("n'ouvre AUCUN relevé pour un compte d'approvisionnement", async () => {
    const caps = await new AlibabaAdapter().capabilities();
    const plan = planReleves(caps, false);

    // Le défaut trouvé en production : trois relevés actifs sur Alibaba,
    // exécutés toutes les dix minutes pour arriver à « rien à faire ».
    expect(plan.every((r) => !r.enabled)).toBe(true);
    expect(coutQuotidien(plan)).toEqual({ taches: 0, operations: 0 });
  });

  it("relève toutes les deux minutes tant que rien n'est poussé", async () => {
    const caps = await new ShopifyAdapter().capabilities();
    const plan = planReleves(caps, false);

    expect(plan.find((r) => r.resource === "orders")?.intervalSec).toBe(120);
    expect(plan.find((r) => r.resource === "inventory")?.intervalSec).toBe(120);
    // 720 + 720 + 1 tâches, soit trois opérations chacune.
    expect(coutQuotidien(plan)).toEqual({ taches: 1441, operations: 4323 });
  });

  it("détend le relevé en filet dès que la boutique pousse vraiment", async () => {
    const caps = await new ShopifyAdapter().capabilities();
    const plan = planReleves(caps, true);

    expect(plan.find((r) => r.resource === "orders")?.intervalSec).toBe(900);
    // 96 + 96 + 1 : sept fois moins, pour une fraîcheur bien meilleure —
    // le webhook arrive en secondes, le relevé mettait deux minutes.
    expect(coutQuotidien(plan)).toEqual({ taches: 193, operations: 579 });
  });

  it("ne détend RIEN sur une plateforme qui ne pousse pas, même marquée abonnée", async () => {
    /*
     * Le piège que ce test verrouille : un drapeau d'abonnement posé par
     * erreur ne doit pas ralentir le relevé d'une plateforme qui ne pousse
     * rien, sans quoi les ventes arriveraient avec un quart d'heure de retard
     * et personne ne saurait pourquoi.
     *
     * Alibaba en est l'exemple net : elle ne pousse pas, et aucun drapeau ne
     * peut y changer quoi que ce soit. eBay tenait ce rôle tant que ses
     * notifications n'étaient pas vérifiées ; elles le sont désormais.
     */
    const caps = await new AlibabaAdapter().capabilities();
    expect(caps.inboundSales).toBe("manual");

    const plan = planReleves(caps, true);
    expect(plan.find((r) => r.resource === "orders")?.intervalSec).toBe(120);
  });

  it("Etsy ne se détend qu'avec son secret de webhook", () => {
    const adapter = new EtsyAdapter();

    /*
     * Le second argument est celui que passe la production : `pousseActive`,
     * la réponse du module. Le figer à `true` dans le test, comme avant,
     * masquait le seul défaut qui compte ici — un noyau qui interroge le
     * mauvais drapeau et laisse la boutique à deux minutes.
     */
    const sansSecret = (() => {
      const c = adapter.capabilities(ctx("etsy"));
      return planReleves(c, c.pousseActive);
    })();
    expect(sansSecret.find((r) => r.resource === "orders")?.intervalSec).toBe(120);

    const avecSecret = (() => {
      const c = adapter.capabilities(ctx("etsy", { webhookSecret: "whsec_x" }));
      return planReleves(c, c.pousseActive);
    })();
    expect(avecSecret.find((r) => r.resource === "orders")?.intervalSec).toBe(900);
  });

  it("eBay se détend dès que ses notifications sont actives", () => {
    /*
     * LE DÉFAUT QUE CE TEST VERROUILLE, CONSTATÉ EN PRODUCTION.
     *
     * Deux abonnements actifs chez eBay, et le relevé toujours à deux
     * minutes : 1 440 tâches par jour au lieu de 192. Le noyau demandait ses
     * capacités au module SANS lui passer les identifiants — or c'est là que
     * le module lit son drapeau. Il répondait donc « pas abonné » quoi qu'il
     * arrive, et le temps réel ne faisait rien gagner.
     *
     * Le test refait la composition exacte de la production : capacités
     * calculées AVEC les identifiants, puis `pousseActive` passé au plan.
     */
    const adapter = new EbayAdapter();

    const sansIdentifiants = adapter.capabilities({} as MarketplaceContext);
    expect(sansIdentifiants.pousseActive).toBe(false);

    const abonne = adapter.capabilities(
      ctx("ebay", { notificationsActives: "1" }),
    );
    expect(abonne.pousseActive).toBe(true);

    const plan = planReleves(abonne, abonne.pousseActive);
    expect(plan.find((r) => r.resource === "orders")?.intervalSec).toBe(900);
    expect(plan.find((r) => r.resource === "inventory")?.intervalSec).toBe(900);
  });

  it("garde le catalogue complet quotidien, quoi qu'il arrive", async () => {
    const caps = await new ShopifyAdapter().capabilities();
    for (const abonne of [false, true]) {
      const listings = planReleves(caps, abonne).find(
        (r) => r.resource === "listings",
      );
      // Titres, descriptions et photos ne bougent pas d'une heure à l'autre :
      // les relever souvent coûte cher et n'apprend rien.
      expect(listings?.intervalSec).toBe(86400);
    }
  });
});

describe("coût de la flotte", () => {
  it("chiffre ce que la migration en temps réel fait gagner", async () => {
    const shopify = await new ShopifyAdapter().capabilities();
    const ebay = new EbayAdapter().capabilities(ctx("ebay"));
    const etsy = new EtsyAdapter().capabilities(ctx("etsy"));

    // L'état constaté en production : trois boutiques relevées, plus Alibaba
    // qui tournait pour rien.
    const avant =
      coutQuotidien(planReleves(shopify, false)).operations +
      coutQuotidien(planReleves(ebay, false)).operations +
      coutQuotidien(planReleves(etsy, false)).operations;
    expect(avant).toBe(12969);
    expect(avant).toBeGreaterThan(10000); // le quota gratuit est déjà dépassé

    // Shopify seul passé en temps réel suffit à repasser dessous.
    const apres =
      coutQuotidien(planReleves(shopify, true)).operations +
      coutQuotidien(planReleves(ebay, false)).operations +
      coutQuotidien(planReleves(etsy, false)).operations;
    expect(apres).toBe(9225);
    expect(apres).toBeLessThan(10000);
  });
});
