import type { CapabilitySet, TargetResult } from "../domain/types.js";
import type {
  MarketplaceAdapter,
  MarketplaceContext,
} from "../ports/marketplace.js";

/**
 * Alibaba.com — une source d'approvisionnement, pas un canal de vente.
 *
 * POURQUOI TOUT EST À « FAUX » ICI, ET POURQUOI CE N'EST PAS UN MANQUE.
 *
 * Les autres adaptateurs décrivent des endroits où l'on VEND : on y publie
 * une annonce, on y écrit un stock, on y relève des commandes de clients.
 * Alibaba est l'inverse — c'est là qu'on ACHÈTE. Il n'y a pas d'annonce à y
 * créer, pas de stock à y pousser, pas de vente à y relever. Déclarer ces
 * capacités à « vrai » promettrait des boutons qui n'ont aucun sens.
 *
 * Sans cet adaptateur, le registre levait « Aucun adaptateur enregistré pour
 * alibaba » à chaque passage de synchronisation — une minute sur deux — et la
 * boutique s'affichait en rouge alors que la connexion fonctionnait
 * parfaitement. Une erreur pour une chose qui n'est pas une erreur.
 *
 * CE QUI VIENDRA ICI. Le compte Alibaba a vocation à alimenter deux choses,
 * et aucune ne passe par le contrat de vente ci-dessous :
 *
 *   1. le STOCK ENTRANT, déduit des commandes d'achat, pour que recevoir un
 *      carton de deux cents pièces ne soit plus une saisie manuelle ;
 *   2. les FICHES FOURNISSEUR — description, attributs, photos — pour bâtir
 *      une annonce sur les vraies boutiques.
 *
 * Ces deux chemins restent à ouvrir. `/alibaba/order/list` répond
 * correctement mais rend un périmètre vide, et la cause n'est pas tranchée :
 * compte sans commande, ou API aveugle aux achats passés à la main sur le
 * site. La sonde de diagnostic garde la question ouverte plutôt que de la
 * refermer sur une supposition.
 */
export class AlibabaAdapter implements MarketplaceAdapter {
  readonly id = "alibaba";

  capabilities(): CapabilitySet {
    return {
      listingCreate: false,
      listingUpdate: false,
      listingActivate: false,
      listingDeactivate: false,
      // On ne lit pas « son » stock chez un fournisseur : ce qu'il annonce
      // disponible n'est pas ce qu'on possède.
      stockRead: false,
      stockWrite: false,
      priceRead: false,
      priceWrite: false,
      // Les commandes d'Alibaba sont des ACHATS, pas des ventes. Les compter
      // comme des ventes ferait décroître un stock qu'elles font croître.
      ordersRead: false,
      ordersFulfill: false,
      trackingWrite: false,
      inboundSales: "manual",
    };
  }

  /**
   * Rien à éprouver par ce chemin.
   *
   * La connexion Alibaba se vérifie par la sonde de diagnostic, qui parle la
   * langue de sa passerelle — signature, rôle, objets de date. Refaire ici un
   * appel signé dupliquerait cette mécanique pour un résultat déjà connu.
   */
  async testConnection(): Promise<void> {}

  private horsSujet(ctx: MarketplaceContext, quoi: string): TargetResult {
    return {
      accountId: ctx.account.id,
      marketplace: ctx.account.marketplace,
      // `unsupported` et non `error` : la commande ne s'applique pas, elle
      // n'a pas échoué. La nuance décide de ce que l'écran affiche.
      status: "unsupported",
      message: `Alibaba est un compte d'approvisionnement : ${quoi} n'y a pas de sens. Publiez sur Shopify, eBay ou Etsy.`,
    };
  }

  async createListing(ctx: MarketplaceContext): Promise<TargetResult> {
    return this.horsSujet(ctx, "publier une annonce");
  }
  async updatePrice(ctx: MarketplaceContext): Promise<TargetResult> {
    return this.horsSujet(ctx, "changer un prix de vente");
  }
  async updateStock(ctx: MarketplaceContext): Promise<TargetResult> {
    return this.horsSujet(ctx, "écrire un stock");
  }
  async activateListing(ctx: MarketplaceContext): Promise<TargetResult> {
    return this.horsSujet(ctx, "remettre une annonce en ligne");
  }
  async deactivateListing(ctx: MarketplaceContext): Promise<TargetResult> {
    return this.horsSujet(ctx, "retirer une annonce");
  }
  async markShipped(ctx: MarketplaceContext): Promise<TargetResult> {
    return this.horsSujet(ctx, "marquer une expédition");
  }
}
