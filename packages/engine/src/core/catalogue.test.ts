import { describe, expect, it } from "vitest";
import { COMMANDES, etatCommande } from "./catalogue.js";
import { EbayAdapter } from "../adapters/ebay.js";
import { EtsyAdapter } from "../adapters/etsy.js";
import { ShopifyAdapter } from "../adapters/shopify.js";
import { VintedSafeAdapter } from "../adapters/vinted-safe.js";
import { AlibabaAdapter } from "../adapters/alibaba.js";
import type { MarketplaceContext } from "../ports/marketplace.js";

/**
 * Le catalogue duplique une information que les adaptateurs portent déjà :
 * les préconditions de leurs capacités conditionnelles. Ce couplage est
 * assumé — `capabilities()` ne renvoie que des booléens, elle a perdu le
 * POURQUOI avant que l'interface la reçoive.
 *
 * Ces tests sont ce qui rend la duplication tenable : ils comparent le
 * catalogue au comportement RÉEL des adaptateurs. Si une précondition change
 * dans un adaptateur sans être reportée ici, un test tombe.
 */

function ctx(
  marketplace: string,
  credentials: Record<string, string> = {},
): MarketplaceContext {
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

const EBAY_COMPLET = {
  merchantLocationKey: "entrepot-1",
  fulfillmentPolicyId: "fp1",
  paymentPolicyId: "pp1",
  returnPolicyId: "rp1",
};

const ETSY_COMPLET = {
  shippingProfileId: "sp1",
  readinessStateId: "rs1",
  returnPolicyId: "rp1",
};

describe("catalogue des commandes", () => {
  it("couvre toutes les commandes de l'orchestrateur", () => {
    // Ajouter une commande sans la déclarer ici la rendrait invisible dans
    // l'interface — elle existerait sans que personne sache qu'elle existe.
    const ids = COMMANDES.map((c) => c.id);
    for (const attendu of [
      "createListing",
      "setPrice",
      "setStock",
      "setActive",
      "deleteListings",
      "fulfillOrder",
    ]) {
      expect(ids).toContain(attendu);
    }
  });

  it("distingue les commandes qui écrivent de celles qui lisent", () => {
    const lectures = COMMANDES.filter((c) => !c.ecrit).map((c) => c.id);
    expect(lectures).toEqual(["fetchListings", "pollOrderEvents"]);
  });

  it("Shopify sait tout faire sans configuration supplémentaire", async () => {
    const caps = await new ShopifyAdapter().capabilities();
    for (const cmd of COMMANDES) {
      expect(etatCommande(cmd, "shopify", caps, {})).toEqual({
        etat: "possible",
      });
    }
  });
});

describe("préconditions eBay", () => {
  const adapter = new EbayAdapter();

  it("nomme les quatre valeurs manquantes plutôt que de dire « non géré »", async () => {
    const caps = adapter.capabilities(ctx("ebay"));
    const cmd = COMMANDES.find((c) => c.id === "createListing")!;
    const r = etatCommande(cmd, "ebay", caps, {});

    expect(r.etat).toBe("bloquee");
    if (r.etat !== "bloquee") return;
    expect(r.manque).toEqual([
      "merchantLocationKey",
      "fulfillmentPolicyId",
      "paymentPolicyId",
      "returnPolicyId",
    ]);
    // Le texte doit dire OÙ aller, pas seulement ce qui manque.
    expect(r.raison).toMatch(/Seller Hub/);
  });

  it("ne signale que ce qui manque réellement", async () => {
    const partiel = { merchantLocationKey: "e1", paymentPolicyId: "pp1" };
    const caps = adapter.capabilities(ctx("ebay", partiel));
    const cmd = COMMANDES.find((c) => c.id === "createListing")!;
    const r = etatCommande(cmd, "ebay", caps, partiel);

    expect(r.etat).toBe("bloquee");
    if (r.etat !== "bloquee") return;
    expect(r.manque).toEqual(["fulfillmentPolicyId", "returnPolicyId"]);
  });

  it("s'ouvre dès que les quatre sont là — accordé avec l'adaptateur", async () => {
    const caps = adapter.capabilities(ctx("ebay", EBAY_COMPLET));
    // Le point du test : l'adaptateur et le catalogue doivent basculer
    // EN MÊME TEMPS. Un catalogue en retard afficherait un bouton qui échoue.
    expect(caps.listingCreate).toBe(true);
    const cmd = COMMANDES.find((c) => c.id === "createListing")!;
    expect(etatCommande(cmd, "ebay", caps, EBAY_COMPLET)).toEqual({
      etat: "possible",
    });
  });

  it("laisse le stock et le prix ouverts sans configuration", async () => {
    const caps = adapter.capabilities(ctx("ebay"));
    for (const id of ["setStock", "setPrice", "fulfillOrder"]) {
      const cmd = COMMANDES.find((c) => c.id === id)!;
      expect(etatCommande(cmd, "ebay", caps, {})).toEqual({ etat: "possible" });
    }
  });
});

describe("préconditions Etsy", () => {
  const adapter = new EtsyAdapter();

  it("nomme les trois valeurs manquantes", async () => {
    const caps = adapter.capabilities(ctx("etsy"));
    const cmd = COMMANDES.find((c) => c.id === "createListing")!;
    const r = etatCommande(cmd, "etsy", caps, {});

    expect(r.etat).toBe("bloquee");
    if (r.etat !== "bloquee") return;
    expect(r.manque).toEqual([
      "shippingProfileId",
      "readinessStateId",
      "returnPolicyId",
    ]);
  });

  it("s'ouvre dès que les trois sont là — accordé avec l'adaptateur", async () => {
    const caps = adapter.capabilities(ctx("etsy", ETSY_COMPLET));
    expect(caps.listingCreate).toBe(true);
    const cmd = COMMANDES.find((c) => c.id === "createListing")!;
    expect(etatCommande(cmd, "etsy", caps, ETSY_COMPLET)).toEqual({
      etat: "possible",
    });
  });

  it("annonce le temps réel seulement quand le secret de webhook est là", () => {
    // Etsy a livré ses webhooks de commande en 2026, mais une notification
    // sans secret vérifiable est refusée : c'est la POUSSÉE EFFECTIVE qui
    // suit le secret. La capacité, elle, ne bouge pas — Etsy sait pousser
    // dans les deux cas, et le dire permet de signaler un secret manquant
    // plutôt que de faire passer la boutique pour incapable.
    expect(adapter.capabilities(ctx("etsy")).pousseActive).toBe(false);
    expect(adapter.capabilities(ctx("etsy")).inboundSales).toBe("both");
    expect(
      adapter.capabilities(ctx("etsy", { webhookSecret: "whsec_x" }))
        .pousseActive,
    ).toBe(true);
  });
});

describe("Vinted, le cas honnête", () => {
  it("déclare tout impossible plutôt que d'échouer à l'usage", async () => {
    const adapter = new VintedSafeAdapter();
    const caps = await adapter.capabilities();
    const ecritures = COMMANDES.filter((c) => c.ecrit);

    for (const cmd of ecritures) {
      const r = etatCommande(cmd, "vinted", caps, {});
      // Ni « possible », ni « bloquée » : rien à configurer, l'API n'existe
      // pas. Promettre une configuration qui débloquerait serait mentir.
      expect(r.etat).toBe("impossible");
    }
  });
});

describe("Alibaba, le cas de l'amont", () => {
  it("ne prétend à aucune commande de vente", async () => {
    const caps = await new AlibabaAdapter().capabilities();

    // Le piège que ce test verrouille : `ordersRead` à vrai ferait compter
    // les ACHATS d'Alibaba comme des ventes, et le stock décroîtrait à chaque
    // réception de marchandise — l'inverse exact de ce qui se passe.
    expect(caps.ordersRead).toBe(false);
    expect(caps.stockWrite).toBe(false);

    for (const cmd of COMMANDES.filter((c) => c.ecrit)) {
      const r = etatCommande(cmd, "alibaba", caps, {});
      // « impossible », pas « bloquée » : aucune configuration ne débloquera
      // la publication d'une annonce chez un fournisseur.
      expect(r.etat).toBe("impossible");
    }
  });
});
