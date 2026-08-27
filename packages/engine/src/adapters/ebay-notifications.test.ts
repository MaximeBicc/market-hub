import { describe, expect, it } from "vitest";
import {
  base64Octets,
  derVersRaw,
  importerClePublique,
  jetonVerificationValide,
  lireEnTeteSignature,
  reponseDefiEbay,
  verifierSignatureEbay,
} from "./ebay-notifications.js";

/**
 * Ces tests ne se contentent pas de vérifier des formes : ils SIGNENT
 * réellement, avec des clés générées à l'instant, puis vérifient. Une
 * conversion DER approximative passerait n'importe quel test d'apparence et
 * échouerait sur une notification réelle, un jour, sans qu'on sache laquelle.
 */

/** Refait le chemin inverse : `r||s` brut vers DER, comme eBay l'émettrait. */
function rawVersDer(raw: Uint8Array): Uint8Array {
  const entier = (v: Uint8Array): number[] => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let b = [...v.subarray(i)];
    // DER encode des entiers SIGNÉS : un octet de tête ≥ 0x80 se ferait lire
    // comme négatif, d'où le zéro ajouté.
    if ((b[0]! & 0x80) !== 0) b = [0x00, ...b];
    return [0x02, b.length, ...b];
  };
  const r = entier(raw.subarray(0, 32));
  const s = entier(raw.subarray(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

async function paire() {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}

function base64(octets: Uint8Array): string {
  return btoa(String.fromCharCode(...octets));
}

describe("en-tête de signature", () => {
  it("décode le JSON encodé en base64", () => {
    const brut = btoa(
      JSON.stringify({
        alg: "ecdsa",
        kid: "9936261a-7d7b-4621-a0f1-96ccb428af49",
        signature: "MEYCIQ==",
        digest: "SHA1",
      }),
    );
    expect(lireEnTeteSignature(brut)).toEqual({
      kid: "9936261a-7d7b-4621-a0f1-96ccb428af49",
      signature: "MEYCIQ==",
      digest: "SHA1",
      alg: "ecdsa",
    });
  });

  it("accepte « ecdsa » en minuscules comme en majuscules", () => {
    /*
     * Le piège : la documentation d'eBay annonce « ECDSA », la charge réelle
     * porte « ecdsa ». Comparer ce champ bloquerait TOUTES les notifications
     * pour une différence de casse dans une valeur décorative.
     */
    for (const alg of ["ecdsa", "ECDSA", "EcDsA"]) {
      const brut = btoa(JSON.stringify({ alg, kid: "k", signature: "s" }));
      expect(lireEnTeteSignature(brut)?.kid).toBe("k");
    }
  });

  it("rend null plutôt que de lever sur une valeur illisible", () => {
    // L'en-tête vient de l'extérieur : il peut être n'importe quoi.
    expect(lireEnTeteSignature("pas du base64 !")).toBeNull();
    expect(lireEnTeteSignature(btoa("pas du json"))).toBeNull();
    expect(lireEnTeteSignature(btoa(JSON.stringify({ kid: "k" })))).toBeNull();
  });
});

describe("conversion DER vers brut", () => {
  it("rend fidèlement une signature, y compris avec l'octet de signe", async () => {
    const p = await paire();
    const message = new TextEncoder().encode("{}");

    /*
     * Trente tirages : sur un échantillon réel, près de la moitié des
     * signatures portent le zéro de signe et une sur trois cents a un entier
     * plus court que la courbe. Un seul tirage passerait à côté des deux.
     */
    let avecSigne = 0;
    for (let i = 0; i < 30; i++) {
      const brut = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-1" },
          p.privateKey,
          message,
        ),
      );
      const der = rawVersDer(brut);
      if (der[3] === 0x21) avecSigne++;
      expect([...derVersRaw(der)]).toEqual([...brut]);
    }
    // Si aucun tirage ne portait le zéro de signe, le test ne prouverait rien
    // de ce qu'il prétend prouver.
    expect(avecSigne).toBeGreaterThan(0);
  });

  it("complète à gauche un entier plus court que la courbe", () => {
    // r = 0x01 sur un octet, s = 32 octets pleins. Sans complément, la
    // signature serait décalée et la vérification échouerait toujours.
    const der = new Uint8Array([
      0x30, 0x26, 0x02, 0x01, 0x01, 0x02, 0x21, 0x00, ...new Array(32).fill(0xaa),
    ]);
    const raw = derVersRaw(der);
    expect(raw).toHaveLength(64);
    expect(raw[31]).toBe(0x01);
    expect([...raw.subarray(0, 31)].every((x) => x === 0)).toBe(true);
  });

  it("refuse une structure qui n'est pas du DER", () => {
    expect(() => derVersRaw(new Uint8Array([0x99, 0x01]))).toThrow(/séquence/);
    expect(() => derVersRaw(new Uint8Array([0x30, 0x02, 0x99, 0x00]))).toThrow(
      /entier/,
    );
  });
});

describe("vérification de bout en bout", () => {
  it("accepte une signature valide, sur le corps BRUT", async () => {
    const p = await paire();
    // Un corps avec des espaces et un ordre de clés particuliers : c'est
    // exactement ce qu'une re-sérialisation détruirait.
    const corps = '{ "notification" : { "data" : { "order" : {} } } }';
    const brut = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-1" },
        p.privateKey,
        new TextEncoder().encode(corps),
      ),
    );
    const spki = new Uint8Array(
      await crypto.subtle.exportKey("spki", p.publicKey),
    );
    const pem = `-----BEGIN PUBLIC KEY-----${base64(spki)}-----END PUBLIC KEY-----`;

    const cle = await importerClePublique(pem);
    expect(
      await verifierSignatureEbay(cle, base64(rawVersDer(brut)), corps),
    ).toBe(true);
  });

  it("refuse le même corps avec un espace de différence", async () => {
    const p = await paire();
    const corps = '{"a":1}';
    const brut = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-1" },
        p.privateKey,
        new TextEncoder().encode(corps),
      ),
    );
    const spki = new Uint8Array(
      await crypto.subtle.exportKey("spki", p.publicKey),
    );
    const cle = await importerClePublique(
      `-----BEGIN PUBLIC KEY-----${base64(spki)}-----END PUBLIC KEY-----`,
    );

    // C'est le piège qui a mordu plusieurs développeurs sur les SDK officiels :
    // désérialiser puis re-sérialiser change les espaces, et la signature ne
    // correspond plus.
    expect(
      await verifierSignatureEbay(cle, base64(rawVersDer(brut)), '{ "a" : 1 }'),
    ).toBe(false);
  });

  it("refuse une signature émise par une autre clé", async () => {
    const bonne = await paire();
    const autre = await paire();
    const corps = '{"a":1}';
    const brut = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-1" },
        autre.privateKey,
        new TextEncoder().encode(corps),
      ),
    );
    const spki = new Uint8Array(
      await crypto.subtle.exportKey("spki", bonne.publicKey),
    );
    const cle = await importerClePublique(
      `-----BEGIN PUBLIC KEY-----${base64(spki)}-----END PUBLIC KEY-----`,
    );
    expect(
      await verifierSignatureEbay(cle, base64(rawVersDer(brut)), corps),
    ).toBe(false);
  });

  it("lit une clé PEM sans aucun saut de ligne", async () => {
    /*
     * eBay rend un PEM DÉGÉNÉRÉ : les marqueurs sont là, les retours à la
     * ligne non. Tous ses SDK ont une fonction pour les réinsérer ; ici on
     * décode directement le SPKI, ce qui rend l'étape inutile.
     */
    const p = await paire();
    const spki = new Uint8Array(
      await crypto.subtle.exportKey("spki", p.publicKey),
    );
    const colle = `-----BEGIN PUBLIC KEY-----${base64(spki)}-----END PUBLIC KEY-----`;
    expect(colle.includes("\n")).toBe(false);
    await expect(importerClePublique(colle)).resolves.toBeDefined();
  });
});

describe("défi d'enregistrement", () => {
  it("hache les trois valeurs dans l'ordre exact", async () => {
    const r = await reponseDefiEbay("abc", "x".repeat(32), "https://h/api");
    // Hexadécimal minuscule, 64 caractères — c'est ce qu'eBay compare.
    expect(r).toMatch(/^[0-9a-f]{64}$/);

    // L'ordre compte : intervertir deux valeurs donne un autre condensé.
    const inverse = await reponseDefiEbay("x".repeat(32), "abc", "https://h/api");
    expect(inverse).not.toBe(r);
  });

  it("une barre oblique finale change la réponse", async () => {
    // Le piège que la documentation signale : l'adresse hachée doit être
    // celle enregistrée, caractère pour caractère.
    const a = await reponseDefiEbay("c", "t".repeat(32), "https://h/api");
    const b = await reponseDefiEbay("c", "t".repeat(32), "https://h/api/");
    expect(a).not.toBe(b);
  });

  it("refuse un jeton de vérification trop court", () => {
    // Trente-deux caractères minimum. « my-secret-token » en fait quinze, et
    // l'enregistrement échoue sans dire que c'est la longueur.
    expect(jetonVerificationValide("my-secret-token")).toBe(false);
    expect(jetonVerificationValide("a".repeat(32))).toBe(true);
    expect(jetonVerificationValide("a".repeat(81))).toBe(false);
    expect(jetonVerificationValide(`${"a".repeat(31)}!`)).toBe(false);
  });
});

describe("base64", () => {
  it("rend les octets, pas des caractères", () => {
    expect([...base64Octets(btoa("\x00\xff\x10"))]).toEqual([0, 255, 16]);
  });
});
