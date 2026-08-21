import type { InventoryItem, ProductId } from "../domain/types.js";
import type { InventoryRepository } from "../ports/repositories.js";

/**
 * Stock central, avec verrouillage optimiste.
 *
 * Le scénario à éviter : le même article se vend au même instant sur eBay et
 * sur Etsy. Deux processus lisent « 3 en stock », retirent 1 chacun, écrivent
 * 2 — et l'on a vendu deux fois en n'en décomptant qu'un. Le compteur
 * `version` empêche cela : la seconde écriture constate que la version a
 * changé et recommence sur la valeur fraîche.
 */
export class InventoryService {
  constructor(private readonly repo: InventoryRepository) {}

  async ensure(productId: ProductId, onHand: number): Promise<InventoryItem> {
    const existing = await this.repo.get(productId);
    if (existing) return existing;
    const item: InventoryItem = { productId, onHand, reserved: 0, version: 1 };
    await this.repo.put(item);
    return item;
  }

  /**
   * Applique une variation. Réessaie tant que la version a bougé sous nos pieds.
   * Huit tentatives : au-delà, il ne s'agit plus de contention normale mais
   * d'un problème qu'il vaut mieux faire remonter que masquer par une boucle.
   */
  async applyDelta(
    productId: ProductId,
    deltaOnHand: number,
  ): Promise<InventoryItem> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const cur = await this.repo.get(productId);
      if (!cur) throw new Error(`Aucun stock pour le produit ${productId}`);
      const next: InventoryItem = {
        ...cur,
        onHand: cur.onHand + deltaOnHand,
        version: cur.version + 1,
      };
      if (await this.repo.compareAndSet(next, cur.version)) return next;
    }
    throw new Error(`Contention persistante sur le stock de ${productId}`);
  }

  /**
   * Aligne le stock central sur une valeur constatée chez une plateforme.
   *
   * À n'appeler QUE lorsqu'on a la preuve que le central n'a pas bougé depuis
   * la dernière lecture — sa `version` en fait foi. Sans cette précaution, une
   * vente encore en cours de propagation serait annulée en recopiant la valeur
   * d'une plateforme qui ne l'a pas encore reçue.
   *
   * Le verrou optimiste est conservé : entre la vérification et l'écriture,
   * une vente peut arriver, et c'est elle qui doit gagner.
   */
  async adopt(productId: ProductId, onHand: number): Promise<InventoryItem> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const cur = await this.repo.get(productId);
      if (!cur) throw new Error(`Aucun stock pour le produit ${productId}`);
      if (cur.onHand === onHand) return cur;
      const next: InventoryItem = {
        ...cur,
        onHand,
        version: cur.version + 1,
      };
      if (await this.repo.compareAndSet(next, cur.version)) return next;
    }
    throw new Error(`Contention persistante sur le stock de ${productId}`);
  }

  /** Réserve une quantité vendue mais pas encore expédiée. */
  async reserve(productId: ProductId, quantity: number): Promise<InventoryItem> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const cur = await this.repo.get(productId);
      if (!cur) throw new Error(`Aucun stock pour le produit ${productId}`);
      const next: InventoryItem = {
        ...cur,
        reserved: Math.max(0, cur.reserved + quantity),
        version: cur.version + 1,
      };
      if (await this.repo.compareAndSet(next, cur.version)) return next;
    }
    throw new Error(`Contention persistante sur le stock de ${productId}`);
  }

  /** Ce qui est réellement vendable : le physique moins ce qui est déjà vendu. */
  available(i: InventoryItem): number {
    return Math.max(0, i.onHand - i.reserved);
  }
}
