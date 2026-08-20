/**
 * Extraction du JSON d'une réponse de modèle.
 *
 * Même en mode « réponse JSON », un modèle ajoute parfois une clôture de bloc
 * Markdown, une phrase d'introduction ou un commentaire final. Analyser
 * directement la chaîne échoue alors sur une réponse pourtant correcte, et la
 * skill part en erreur pour une virgule de politesse.
 *
 * On tente donc dans l'ordre : la chaîne telle quelle, puis le contenu d'un
 * bloc de code, puis le plus grand objet ou tableau équilibré trouvé dans le
 * texte. Si rien ne tient, on renvoie `undefined` — jamais un objet inventé.
 */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const direct = attempt(trimmed);
  if (direct !== undefined) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    const parsed = attempt(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  const extracted = extractBalanced(trimmed);
  return extracted === undefined ? undefined : attempt(extracted);
}

function attempt(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Isole le premier objet ou tableau syntaxiquement équilibré.
 *
 * Le comptage ignore les accolades situées dans une chaîne — sans quoi un
 * texte contenant `"prix { remisé }"` ferait dérailler la profondeur et
 * couperait le JSON au mauvais endroit.
 */
function extractBalanced(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Lecture défensive — un modèle n'est pas un schéma                   */
/* ------------------------------------------------------------------ */

/** Ramène une valeur entre 0 et 1. Toute absurdité devient `fallback`. */
export function ratio(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/** Nombre fini, ou `null`. On ne remplace jamais un inconnu par un zéro. */
export function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function stringList(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .map((v) => String(v).slice(0, 300))
    .slice(0, max);
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
