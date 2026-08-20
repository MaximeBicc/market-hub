/**
 * Erreurs qui savent ce qu'elles ont coûté.
 *
 * Un appel raté n'est pas forcément un appel gratuit. Le cas observé en
 * production le 20 août 2026 : un modèle de Workers AI dépense la totalité de
 * son budget de sortie en raisonnement, ne rend aucune réponse, et la
 * consommation est bel et bien décomptée de l'allocation.
 *
 * Une erreur ordinaire perdrait cette facture en chemin. Le solde affiché
 * deviendrait plus généreux que la réalité — dans le seul sens qui compte,
 * celui qui mène au dépassement sans que rien ne l'annonce.
 */

export interface FailureUsage {
  inputTokens: number;
  outputTokens: number;
  /** Coût annoncé par le fournisseur. Absent, on retombe sur la conversion. */
  neurons?: number | undefined;
}

export class BilledFailure extends Error {
  constructor(
    message: string,
    readonly usage: FailureUsage,
  ) {
    super(message);
    this.name = "BilledFailure";
  }
}

/**
 * Le modèle a épuisé son budget de sortie en raisonnement, sans rien écrire.
 *
 * Tous les modèles du catalogue Workers AI réfléchissent à voix haute avant de
 * répondre, et cette réflexion consomme le budget de sortie. Sans cette
 * erreur, la skill recevrait une chaîne vide, l'analyserait en `undefined`, et
 * rendrait un résultat plausible entièrement fait de valeurs par défaut — le
 * pire des échecs, celui qui ne ressemble pas à un échec.
 */
export class TruncatedBeforeAnswerError extends BilledFailure {
  constructor(model: string, tokens: number, usage: FailureUsage) {
    super(
      `Le modèle ${model} a épuisé ses ${tokens} jetons de sortie en raisonnement, sans écrire de réponse.`,
      usage,
    );
    this.name = "TruncatedBeforeAnswerError";
  }
}

/** La facture d'un échec, quand il en porte une. */
export function usageOfFailure(error: unknown): FailureUsage | undefined {
  return error instanceof BilledFailure ? error.usage : undefined;
}
