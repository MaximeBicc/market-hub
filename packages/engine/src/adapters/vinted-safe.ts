import type { CapabilitySet, TargetResult } from "../domain/types.js";
import type {
  MarketplaceAdapter,
  MarketplaceContext,
} from "../ports/marketplace.js";

/**
 * Vinted — mode sûr.
 *
 * POURQUOI CET ADAPTATEUR NE FAIT RIEN, ET POURQUOI C'EST LE BON CHOIX.
 *
 * Vinted n'expose aucune API publique aux développeurs tiers. Il existe une
 * API officielle, « Vinted Pro Integrations », mais elle est réservée aux
 * comptes professionnels inscrits sur liste blanche, via un portail dédié.
 *
 * Tout ce qui circule par ailleurs — bibliothèques « API Vinted » trouvées en
 * ligne, appels à l'API interne de l'application, automatisation de navigateur
 * connecté — consiste à se faire passer pour l'application officielle avec les
 * jetons de session d'un compte réel. C'est précisément ce qui déclenche les
 * blocages de compte, et vous avez demandé l'inverse.
 *
 * L'adaptateur déclare donc honnêtement qu'il ne sait rien faire, et renvoie
 * `manual_required` plutôt que d'échouer : ce n'est pas une panne, c'est une
 * tâche pour un humain. L'interface peut ainsi afficher « à publier à la main
 * sur Vinted » au lieu d'une erreur rouge.
 *
 * DÈS QUE L'ACCÈS PRO EST OBTENU, cet adaptateur est remplacé par un vrai
 * client HTTP : le reste du système n'a pas à changer d'une ligne, puisque le
 * contrat est le même. C'est tout l'intérêt de la couche d'adaptateurs.
 */
export class VintedSafeAdapter implements MarketplaceAdapter {
  readonly id = "vinted";

  capabilities(): CapabilitySet {
    return {
      listingCreate: false,
      listingUpdate: false,
      listingActivate: false,
      listingDeactivate: false,
      stockRead: false,
      stockWrite: false,
      priceRead: false,
      priceWrite: false,
      ordersRead: false,
      inboundSales: "manual",
    };
  }

  /** Rien à tester : aucune connexion n'est établie. */
  async testConnection(): Promise<void> {}

  private manual(ctx: MarketplaceContext, what: string): TargetResult {
    return {
      accountId: ctx.account.id,
      marketplace: ctx.account.marketplace,
      status: "manual_required",
      message: `Vinted : ${what} à faire à la main (aucune API sans accès Vinted Pro).`,
    };
  }

  async createListing(ctx: MarketplaceContext): Promise<TargetResult> {
    return this.manual(ctx, "publication de l'annonce");
  }
  async updatePrice(ctx: MarketplaceContext): Promise<TargetResult> {
    return this.manual(ctx, "changement de prix");
  }
  async updateStock(ctx: MarketplaceContext): Promise<TargetResult> {
    return this.manual(ctx, "mise à jour du stock");
  }
  async activateListing(ctx: MarketplaceContext): Promise<TargetResult> {
    return this.manual(ctx, "remise en ligne");
  }
  async deactivateListing(ctx: MarketplaceContext): Promise<TargetResult> {
    return this.manual(ctx, "retrait de l'annonce");
  }
}
