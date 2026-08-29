import { Hono } from "hono";
import type { Env } from "../env.js";
import { authenticate } from "../lib/session.js";
import { randomId } from "../lib/crypto.js";

/**
 * LES PHOTOS RETOUCHÉES, HÉBERGÉES ICI.
 *
 * Une photo recadrée dans le navigateur n'existe nulle part : les plateformes
 * ne reçoivent pas une image, elles reçoivent une ADRESSE et vont la chercher
 * elles-mêmes. Sans hébergement, la retouche mourait à la fermeture de
 * l'onglet.
 *
 * POURQUOI KV ET PAS R2. R2 est le stockage d'objets prévu pour ça — mais il
 * n'est pas provisionné, et son activation peut réclamer un moyen de paiement,
 * ce que le projet s'interdit. KV est déjà en place, accepte 25 Mo par valeur
 * et n'a pas d'usage concurrent ici. Quelques dizaines de photos y tiennent
 * sans approcher aucune limite.
 *
 * La lecture est PUBLIQUE, et c'est indispensable : c'est eBay, Etsy et
 * Shopify qui viennent chercher l'image, sans session ni jeton. L'écriture,
 * elle, exige d'être connecté.
 */
export const media = new Hono<{ Bindings: Env }>();

/** Deux mégaoctets : large pour une photo carrée en haute définition. */
const TAILLE_MAX = 2 * 1024 * 1024;

/**
 * Sert une photo retouchée.
 *
 * Déclarée AVANT la garde d'authentification : les places de marché n'ont pas
 * de session. L'identifiant est tiré au hasard sur vingt-deux caractères —
 * il n'y a rien à énumérer, et rien d'autre n'est exposé.
 */
media.get("/:id", async (c) => {
  const id = c.req.param("id");
  // On ne concatène jamais un paramètre d'URL dans une clé sans le borner :
  // une clé fabriquée irait lire ailleurs dans le même espace de noms.
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) {
    return c.json({ error: "not_found" }, 404);
  }

  const objet = await c.env.CACHE.getWithMetadata(`media:${id}`, "arrayBuffer");
  if (!objet.value) return c.json({ error: "not_found" }, 404);

  const type =
    (objet.metadata as { type?: string } | null)?.type === "image/png"
      ? "image/png"
      : "image/jpeg";

  return new Response(objet.value, {
    headers: {
      "Content-Type": type,
      // Immuable : le contenu ne change jamais pour un identifiant donné.
      // C'est ce qui évite que trois plateformes le retéléchargent en boucle.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

/*
 * La garde ne couvre QUE ce qui suit : la lecture, déclarée plus haut, reste
 * publique. C'est l'ordre de déclaration qui fait la frontière — l'inverser
 * rendrait les images invisibles aux plateformes sans qu'aucun test local ne
 * le remarque, puisqu'un navigateur connecté, lui, les verrait.
 */
media.use("*", async (c, next) => {
  const me = await authenticate(c.env, c.req.raw);
  if (!me) return c.json({ error: "unauthorized" }, 401);
  await next();
});

/**
 * Reçoit une photo retouchée et rend son adresse.
 *
 * Le corps est l'image brute, pas un formulaire : elle sort d'un canvas, il
 * n'y a rien d'autre à transmettre.
 */
media.post("/", async (c) => {
  const type = c.req.header("content-type") ?? "";
  if (!/^image\/(jpeg|png)$/.test(type)) {
    return c.json({ error: "Seules les images JPEG ou PNG sont acceptées." }, 400);
  }

  const octets = await c.req.arrayBuffer();
  if (octets.byteLength === 0) {
    return c.json({ error: "Image vide." }, 400);
  }
  if (octets.byteLength > TAILLE_MAX) {
    return c.json(
      { error: `Image trop lourde (${Math.round(octets.byteLength / 1024)} Ko, maximum ${TAILLE_MAX / 1024} Ko).` },
      400,
    );
  }

  const id = randomId();
  /*
   * AUCUNE EXPIRATION. Une photo retouchée vit aussi longtemps que l'annonce
   * qui la montre — souvent des mois. Poser une durée de vie ferait
   * disparaître l'image des trois boutiques à une date que personne n'aurait
   * notée, et le vendeur découvrirait des fiches sans visuel.
   */
  await c.env.CACHE.put(`media:${id}`, octets, {
    metadata: { type: type === "image/png" ? "image/png" : "image/jpeg" },
  });

  const base = c.env.APP_URL.replace(/\/+$/, "");
  return c.json({ url: `${base}/api/media/${id}` });
});
