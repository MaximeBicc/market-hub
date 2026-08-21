import { describe, expect, it } from "vitest";
import { reconcileStock } from "./stock-reconciliation.js";

/**
 * Les huit combinaisons de la règle de rapprochement.
 *
 * Chaque cas correspond à une situation réelle, nommée. Une erreur ici ne se
 * voit pas dans l'interface : elle se voit en survendant un article, ou en le
 * gardant invendable alors qu'il est en stock.
 */
describe("rapprochement du stock", () => {
  it("ne fait rien quand les deux côtés s'accordent", () => {
    expect(
      reconcileStock({
        centralOnHand: 9,
        centralVersion: 3,
        seenVersion: 3,
        remoteStock: 9,
      }),
    ).toEqual({ action: "none" });
  });

  it("ne fait rien si le central a bougé mais que la plateforme a déjà reçu", () => {
    // Le cas qui suit une propagation réussie : inutile de réécrire.
    expect(
      reconcileStock({
        centralOnHand: 7,
        centralVersion: 4,
        seenVersion: 3,
        remoteStock: 7,
      }),
    ).toEqual({ action: "none" });
  });

  it("pousse vers la plateforme quand une vente a décrémenté le central", () => {
    const d = reconcileStock({
      centralOnHand: 7,
      centralVersion: 4,
      seenVersion: 3,
      remoteStock: 9,
    });
    expect(d.action).toBe("push");
    expect(d).toMatchObject({ stock: 7 });
  });

  it("adopte la valeur de la plateforme quand le central n'a pas bougé", () => {
    // Quelqu'un a modifié le stock directement chez la plateforme : c'est la
    // valeur la plus récente, et l'ancienne version la laissait perdue.
    const d = reconcileStock({
      centralOnHand: 9,
      centralVersion: 3,
      seenVersion: 3,
      remoteStock: 15,
    });
    expect(d.action).toBe("adopt");
    expect(d).toMatchObject({ stock: 15 });
  });

  it("adopte aussi à la baisse", () => {
    const d = reconcileStock({
      centralOnHand: 15,
      centralVersion: 3,
      seenVersion: 3,
      remoteStock: 2,
    });
    expect(d).toMatchObject({ action: "adopt", stock: 2 });
  });

  it("adopte lors d'une première lecture, faute de version mémorisée", () => {
    // seenVersion = 0 : l'annonce n'a jamais été rapprochée. La version 1 du
    // central est celle de sa création, pas d'un mouvement — la plateforme
    // reste donc la seule source d'information réelle.
    //
    // C'est l'état exact des annonces importées avant ce rapprochement :
    // traiter « version 1 » comme un mouvement écraserait un stock modifié à
    // la main chez la plateforme par la valeur figée de l'import.
    const d = reconcileStock({
      centralOnHand: 9,
      centralVersion: 1,
      seenVersion: 0,
      remoteStock: 15,
    });
    expect(d).toMatchObject({ action: "adopt", stock: 15 });
  });

  it("pousse si le central a bougé avant même la première lecture", () => {
    // Version 2 sans lecture mémorisée : le stock a été créé PUIS modifié,
    // typiquement par une vente sur un autre canal. Là, il a vraiment bougé.
    const d = reconcileStock({
      centralOnHand: 8,
      centralVersion: 2,
      seenVersion: 0,
      remoteStock: 9,
    });
    expect(d).toMatchObject({ action: "push", stock: 8 });
  });

  it("adopte plutôt que de pousser quand la version mémorisée est à jour", () => {
    const d = reconcileStock({
      centralOnHand: 9,
      centralVersion: 1,
      seenVersion: 1,
      remoteStock: 15,
    });
    expect(d).toMatchObject({ action: "adopt", stock: 15 });
  });

  it("gère le zéro comme une valeur, pas comme une absence", () => {
    // Piège classique : traiter 0 comme « pas de donnée » laisserait un
    // article épuisé s'afficher comme disponible.
    expect(
      reconcileStock({
        centralOnHand: 4,
        centralVersion: 2,
        seenVersion: 2,
        remoteStock: 0,
      }),
    ).toMatchObject({ action: "adopt", stock: 0 });

    expect(
      reconcileStock({
        centralOnHand: 0,
        centralVersion: 5,
        seenVersion: 2,
        remoteStock: 4,
      }),
    ).toMatchObject({ action: "push", stock: 0 });
  });

  it("explique toujours sa décision", () => {
    const pousse = reconcileStock({
      centralOnHand: 7,
      centralVersion: 4,
      seenVersion: 3,
      remoteStock: 9,
    });
    const adopte = reconcileStock({
      centralOnHand: 9,
      centralVersion: 3,
      seenVersion: 3,
      remoteStock: 15,
    });
    // Le motif part dans le journal : sans lui, un stock corrigé à 3 h du
    // matin est indistinguable d'un bug.
    expect(pousse).toHaveProperty("reason");
    expect(adopte).toHaveProperty("reason");
  });
});
