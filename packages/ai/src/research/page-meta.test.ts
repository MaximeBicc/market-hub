import { describe, expect, it } from "vitest";
import { centimesDepuis, lireMeta } from "./page-meta.js";

/**
 * Une page marchande se décrit dans son en-tête. On l'écoute — mais pas
 * n'importe qui, et pas n'importe comment.
 */

describe("lecture d'un prix écrit", () => {
  it("comprend le séparateur français", () => {
    expect(centimesDepuis("12,90 €")).toBe(1_290);
    expect(centimesDepuis("1 299,99 €")).toBe(129_999);
  });

  it("comprend le séparateur anglo-saxon", () => {
    expect(centimesDepuis("12.90")).toBe(1_290);
    expect(centimesDepuis("$1,299.99")).toBe(129_999);
  });

  it("rend null plutôt qu'un zéro quand il n'y a pas de nombre", () => {
    // Un prix absent doit rester absent : zéro serait un prix, et il entrerait
    // dans une médiane.
    expect(centimesDepuis("Prix sur demande")).toBeNull();
    expect(centimesDepuis("")).toBeNull();
    expect(centimesDepuis("0")).toBeNull();
  });
});

describe("refus des adresses non publiques", () => {
  /**
   * Les URL viennent d'un moteur de recherche, donc d'un tiers. Sans ce garde,
   * une adresse interne pourrait être interrogée depuis le Worker — la faille
   * dite SSRF. On la ferme ici, avant tout appel réseau.
   */
  const refusees = [
    "http://localhost:8787/api/health",
    "http://127.0.0.1/",
    "http://10.0.0.5/interne",
    "http://192.168.1.1/admin",
    "http://172.16.0.9/",
    "http://169.254.169.254/latest/meta-data/",
    "file:///etc/passwd",
    "http://user:motdepasse@exemple.fr/",
    "pas une url",
  ];

  for (const url of refusees) {
    it(`refuse ${url}`, async () => {
      // Aucun appel réseau n'a lieu : le refus précède le fetch, donc ce test
      // ne joint rien même sans simulation.
      const meta = await lireMeta(url);
      expect(meta).toEqual({
        imageUrl: null,
        price: null,
        currency: null,
        availability: null,
      });
    });
  }
});
