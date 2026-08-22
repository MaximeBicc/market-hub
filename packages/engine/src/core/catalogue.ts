import type { CapabilitySet, MarketplaceId } from "../domain/types.js";

/**
 * LE CATALOGUE DES COMMANDES.
 *
 * L'orchestrateur ne connaît que des commandes ; chaque adaptateur déclare ce
 * qu'il sait faire. Entre les deux, personne ne disait à quoi correspond quoi.
 * Ce fichier est ce chaînon : il nomme les commandes, dit quelle capacité
 * chacune exige, et — c'est là tout l'intérêt — pourquoi une commande est
 * fermée quand elle l'est.
 *
 * Sans ce dernier point, l'interface ne peut que griser un bouton. « eBay ne
 * gère pas listingCreate » est vrai et inutile : eBay le gère très bien, il
 * manque une adresse d'expédition et trois politiques dans le compte vendeur.
 * La différence entre les deux phrases, c'est la différence entre un outil
 * qu'on subit et un outil qu'on configure.
 *
 * Ce catalogue vit dans le moteur, à côté du contrat qu'il décrit : ajouter
 * une commande sans l'y déclarer se remarque à la relecture d'un seul fichier.
 */

export interface CommandeCatalogue {
  /** Nom de la méthode sur l'orchestrateur. */
  id: string;
  /** Ce que ça fait, en français, pour un humain. */
  libelle: string;
  /**
   * La clé de capacité vérifiée avant d'appeler l'adaptateur.
   * Certaines commandes en vérifient deux selon leur argument — d'où le tableau.
   */
  exige: Array<keyof CapabilitySet>;
  /** Vrai si la commande écrit chez la plateforme. */
  ecrit: boolean;
  /** Diffusée vers plusieurs comptes, ou visant un compte unique. */
  portee: "multi" | "unique";
}

export const COMMANDES: readonly CommandeCatalogue[] = [
  {
    id: "createListing",
    libelle: "Publier un produit en annonce",
    exige: ["listingCreate"],
    ecrit: true,
    portee: "multi",
  },
  {
    id: "setPrice",
    libelle: "Changer le prix",
    exige: ["priceWrite"],
    ecrit: true,
    portee: "multi",
  },
  {
    id: "setStock",
    libelle: "Écrire le stock",
    exige: ["stockWrite"],
    ecrit: true,
    portee: "multi",
  },
  {
    id: "setActive",
    libelle: "Activer ou désactiver une annonce",
    // Deux clés, choisies selon le sens de l'action.
    exige: ["listingActivate", "listingDeactivate"],
    ecrit: true,
    portee: "multi",
  },
  {
    id: "fulfillOrder",
    libelle: "Marquer expédié, avec suivi",
    // `trackingWrite` si un numéro est fourni, `ordersFulfill` sinon.
    exige: ["ordersFulfill", "trackingWrite"],
    ecrit: true,
    portee: "unique",
  },
  {
    id: "fetchListings",
    libelle: "Lire le catalogue existant",
    exige: ["stockRead"],
    ecrit: false,
    portee: "unique",
  },
  {
    id: "pollOrderEvents",
    libelle: "Relever les ventes",
    exige: ["ordersRead"],
    ecrit: false,
    portee: "unique",
  },
] as const;

/**
 * Ce qui manque à un compte pour débloquer une capacité conditionnelle.
 *
 * Les préconditions sont écrites ici plutôt que dans chaque adaptateur pour
 * une raison précise : `capabilities()` renvoie des booléens, elle a déjà
 * perdu l'information du POURQUOI au moment où l'interface la reçoit. Les
 * dupliquer ici est un couplage assumé — et les tests le verrouillent, en
 * comparant ce tableau au comportement réel des adaptateurs.
 */
export interface Precondition {
  capacite: keyof CapabilitySet;
  /** Clés d'identifiants qui doivent toutes être présentes. */
  cles: string[];
  /** Où les obtenir, en clair. */
  ou: string;
}

const PRECONDITIONS: Partial<Record<MarketplaceId, Precondition[]>> = {
  ebay: [
    {
      capacite: "listingCreate",
      cles: [
        "merchantLocationKey",
        "fulfillmentPolicyId",
        "paymentPolicyId",
        "returnPolicyId",
      ],
      ou: "eBay refuse de publier sans une adresse d'expédition et trois politiques (paiement, retour, livraison). Elles se créent dans Seller Hub → Paramètres du compte → Préférences de vente.",
    },
  ],
  etsy: [
    {
      capacite: "listingCreate",
      cles: ["shippingProfileId", "readinessStateId", "taxonomyId"],
      ou: "Etsy impose sur tout objet physique un profil de livraison, un délai de préparation et une catégorie. Les deux premiers se créent dans la boutique ; la catégorie se choisit dans la taxonomie Etsy.",
    },
  ],
};

/**
 * L'état d'une commande pour un compte donné.
 *
 * `bloquee` porte la nuance qui compte : la commande existe, la plateforme
 * sait la faire, il manque une configuration nommée.
 */
export type EtatCommande =
  | { etat: "possible" }
  | { etat: "impossible"; raison: string }
  | { etat: "bloquee"; manque: string[]; raison: string };

export function etatCommande(
  commande: CommandeCatalogue,
  marketplace: MarketplaceId,
  capacites: CapabilitySet,
  credentials: Record<string, string> | undefined,
): EtatCommande {
  // `setActive` et `fulfillOrder` ont deux clés : il suffit d'une pour que la
  // commande soit au moins partiellement praticable.
  const ouverte = commande.exige.some((k) => capacites[k] === true);
  if (ouverte) return { etat: "possible" };

  const precondition = PRECONDITIONS[marketplace]?.find((p) =>
    commande.exige.includes(p.capacite),
  );

  if (precondition) {
    const c = credentials ?? {};
    const manque = precondition.cles.filter((k) => !c[k]);
    if (manque.length > 0) {
      return { etat: "bloquee", manque, raison: precondition.ou };
    }
  }

  return {
    etat: "impossible",
    raison: `${marketplace} n'expose pas cette opération dans son API.`,
  };
}
