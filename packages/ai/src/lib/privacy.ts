import type { AIMessage } from "../domain/types.js";

/**
 * Nettoyage du texte partant chez un fournisseur externe.
 *
 * CE QUE CETTE FONCTION N'EST PAS : une autorisation d'envoyer des données
 * client à un tiers. Le texte écrit par un acheteur est classé `customer` et
 * le routeur ne lui propose que des modèles hébergés chez nous — il n'atteint
 * jamais ce code.
 *
 * Ce nettoyeur ne s'applique qu'à la classe `internal` : nos propres chiffres,
 * partant vers Gemini ou Groq. La vraie protection est en amont — les skills
 * construisent un objet explicite, champ par champ, plutôt que de sérialiser
 * une ligne de base entière. Ce filtre est la seconde ligne : il rattrape le
 * nom d'acheteur ou l'adresse qu'un champ libre aurait laissé passer.
 *
 * Ses limites, sans détour : il reconnaît des FORMES, pas des identités. Il
 * masque une adresse électronique, un numéro de téléphone, un IBAN, une carte
 * ou un identifiant de commande. Il ne masque pas « Mme Dupont, la dame du
 * troisième ». Ne comptez jamais sur lui pour rendre anonyme un texte libre.
 */

interface Rule {
  pattern: RegExp;
  replacement: string;
}

const RULES: Rule[] = [
  { pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replacement: "[courriel]" },
  // Numéros français et internationaux : au moins neuf chiffres, séparateurs
  // usuels tolérés. Le préfixe évite d'avaler un prix ou une référence.
  {
    pattern: /(?:\+\d{1,3}[\s.-]?)?(?:\d[\s.-]?){9,14}\d/g,
    replacement: "[téléphone]",
  },
  { pattern: /\b[A-Z]{2}\d{2}[\s]?(?:[A-Z0-9]{4}[\s]?){2,7}[A-Z0-9]{1,4}\b/g, replacement: "[iban]" },
  { pattern: /\b(?:\d[ -]?){13,19}\b/g, replacement: "[carte]" },
  // Identifiants de commande des plateformes : #1234567890, ORD-8899...
  { pattern: /\b(?:#|ORD[-_]?|CMD[-_]?)\d{5,}\b/gi, replacement: "[commande]" },
];

export function sanitize(text: string): string {
  let out = text;
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replacement);
  return out;
}

/** Applique le nettoyage à un message complet, parties textuelles seulement. */
export function sanitizeMessages(messages: AIMessage[]): AIMessage[] {
  return messages.map((message) => ({
    ...message,
    content:
      typeof message.content === "string"
        ? sanitize(message.content)
        : message.content.map((part) =>
            part.type === "text" ? { ...part, text: sanitize(part.text) } : part,
          ),
  }));
}
