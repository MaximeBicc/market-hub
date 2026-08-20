/**
 * Empreinte stable d'une valeur quelconque.
 *
 * Sert de clé de cache : deux demandes identiques doivent produire la même
 * empreinte, quel que soit l'ordre dans lequel le navigateur a sérialisé les
 * champs. `JSON.stringify` conserve l'ordre d'insertion — sans tri, une même
 * demande envoyée par deux écrans différents raterait le cache et consommerait
 * deux fois l'allocation gratuite.
 */
export async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` disparaît de JSON.stringify : on l'écarte ici aussi, sinon
    // `{a:1}` et `{a:1,b:undefined}` donneraient deux empreintes différentes
    // pour deux objets identiques une fois sérialisés.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
