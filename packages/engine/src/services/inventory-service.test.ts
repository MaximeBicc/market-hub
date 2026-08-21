import { describe, expect, it } from "vitest";
import { InventoryService } from "./inventory-service.js";
import { MemoryInventoryRepository } from "../testing/memory-repositories.js";
import type { InventoryItem } from "../domain/types.js";

/**
 * `adopt` aligne le stock central sur une valeur constatée chez une
 * plateforme. C'est l'opération qui manquait : sans elle, un stock modifié à
 * la main dans Shopify n'arrivait jamais jusqu'ici, et l'écart se journalisait
 * indéfiniment sans jamais se résorber.
 */
describe("adoption d'un stock observé", () => {
  it("écrit la valeur exacte et incrémente la version", async () => {
    const repo = new MemoryInventoryRepository();
    const svc = new InventoryService(repo);
    await svc.ensure("p1", 9);

    const r = await svc.adopt("p1", 15);

    expect(r.onHand).toBe(15);
    expect(r.version).toBe(2);
    expect((await repo.get("p1"))?.onHand).toBe(15);
  });

  it("n'écrit rien quand la valeur est déjà la bonne", async () => {
    const repo = new MemoryInventoryRepository();
    const svc = new InventoryService(repo);
    await svc.ensure("p1", 9);

    const r = await svc.adopt("p1", 9);

    // La version ne bouge pas : sinon chaque passage de synchronisation ferait
    // croire au rapprochement suivant que le central vient de changer, et
    // déclencherait une poussée inutile vers toutes les plateformes.
    expect(r.version).toBe(1);
  });

  it("ne touche pas au réservé", async () => {
    const repo = new MemoryInventoryRepository();
    const svc = new InventoryService(repo);
    await svc.ensure("p1", 9);
    await svc.reserve("p1", 2);

    const r = await svc.adopt("p1", 15);

    // Le réservé couvre des ventes déjà constatées : une valeur lue chez la
    // plateforme ne dit rien à leur sujet.
    expect(r.reserved).toBe(2);
    expect(svc.available(r)).toBe(13);
  });

  it("accepte zéro comme une valeur", async () => {
    const repo = new MemoryInventoryRepository();
    const svc = new InventoryService(repo);
    await svc.ensure("p1", 9);
    expect((await svc.adopt("p1", 0)).onHand).toBe(0);
  });

  it("refuse un produit sans stock plutôt que d'en inventer un", async () => {
    const svc = new InventoryService(new MemoryInventoryRepository());
    await expect(svc.adopt("inconnu", 5)).rejects.toThrow(/Aucun stock/);
  });

  it("laisse gagner une vente survenue pendant l'adoption", async () => {
    const repo = new MemoryInventoryRepository();
    const svc = new InventoryService(repo);
    await svc.ensure("p1", 9);

    // Une vente se glisse entre la lecture et l'écriture : le verrou optimiste
    // doit faire échouer la première tentative, pas écraser la vente.
    let premierPassage = true;
    const vraiGet = repo.get.bind(repo);
    repo.get = async (id: string): Promise<InventoryItem | undefined> => {
      const cur = await vraiGet(id);
      if (premierPassage && cur) {
        premierPassage = false;
        await repo.compareAndSet(
          { ...cur, onHand: cur.onHand - 1, version: cur.version + 1 },
          cur.version,
        );
      }
      return cur;
    };

    const r = await svc.adopt("p1", 15);

    // L'adoption finit par passer, mais seulement après avoir relu.
    expect(r.onHand).toBe(15);
    expect(r.version).toBeGreaterThanOrEqual(3);
  });
});
