/**
 * Qui a raison, le stock central ou la plateforme ?
 *
 * La question posée ainsi n'a pas de réponse. Celle qui en a une est : QUI A
 * BOUGÉ depuis la dernière fois qu'on a regardé ? Le stock central porte un
 * compteur de version incrémenté à chaque modification ; chaque annonce
 * mémorise la version qu'elle avait vue. Comparer les deux tranche sans
 * ambiguïté, et c'est tout ce que fait cette fonction.
 *
 * Pourquoi la sortir du code de synchronisation : c'est la règle la plus
 * délicate de l'outil, celle dont une erreur se paie en stock faux — donc en
 * survente ou en ventes manquées. Isolée, elle s'éprouve sur les huit
 * combinaisons possibles sans base de données ni réseau.
 */

export type StockDecision =
  | { action: "none" }
  /** La plateforme a été modifiée hors de l'outil : sa valeur devient le central. */
  | { action: "adopt"; stock: number; reason: string }
  /** Le central a bougé (une vente ailleurs) : la plateforme est en retard. */
  | { action: "push"; stock: number; reason: string };

export function reconcileStock(input: {
  /** Stock central actuel. */
  centralOnHand: number;
  /** Version actuelle du stock central. */
  centralVersion: number;
  /**
   * Version du central mémorisée sur l'annonce à la dernière lecture.
   * Zéro pour une annonce jamais rapprochée — auquel cas on considère que le
   * central n'a pas bougé, et c'est la plateforme qui fait foi. C'est le bon
   * défaut : à la toute première lecture, la plateforme est la seule source.
   */
  seenVersion: number;
  /** Ce que la plateforme affiche maintenant. */
  remoteStock: number;
}): StockDecision {
  const { centralOnHand, centralVersion, seenVersion, remoteStock } = input;

  // Les deux côtés s'accordent : quoi qu'il se soit passé, il n'y a rien à
  // faire. Ce test vient en premier pour qu'un central qui a bougé mais que
  // la plateforme a déjà reçu ne déclenche pas d'écriture inutile.
  if (centralOnHand === remoteStock) return { action: "none" };

  /*
   * La version 1 est celle de la CRÉATION du stock central, pas d'un
   * mouvement. Une annonce jamais rapprochée a une version mémorisée de 0 :
   * comparer naïvement ferait alors passer « ce stock existe » pour « ce stock
   * vient de changer », et pousserait une valeur d'origine par-dessus une
   * modification faite chez la plateforme.
   *
   * Ce cas n'est pas théorique : c'est exactement l'état des annonces
   * importées avant l'existence de ce rapprochement.
   */
  const reference = Math.max(seenVersion, 1);

  if (centralVersion > reference) {
    return {
      action: "push",
      stock: centralOnHand,
      reason: `le stock central est passé en version ${centralVersion} depuis la dernière lecture (${seenVersion})`,
    };
  }

  return {
    action: "adopt",
    stock: remoteStock,
    reason: `le stock central n'a pas bougé (version ${centralVersion}), la plateforme si`,
  };
}
