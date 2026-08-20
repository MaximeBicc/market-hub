import type { Skill } from "../domain/types.js";
import { productAnalyze } from "../skills/product-analyze.js";
import { priceRecommend } from "../skills/price-recommend.js";
import { restockRecommend } from "../skills/restock-recommend.js";
import { anomalyDetect } from "../skills/anomaly-detect.js";
import { marketResearch } from "../skills/market-research.js";
import { supplierFind } from "../skills/supplier-find.js";

/**
 * Registre des skills — le seul point d'entrée vers une analyse.
 *
 * Même rôle que le registre d'adaptateurs du moteur marketplace : ajouter une
 * capacité se fait ici et dans son fichier, nulle part ailleurs. Les routes,
 * la file d'attente et l'interface passent toutes par ce registre et n'ont
 * donc jamais à connaître la liste.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  register(skill: Skill): this {
    this.skills.set(skill.name, skill);
    return this;
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** Description publique : ce que l'interface a le droit de savoir. */
  list(): Array<Pick<Skill, "name" | "version" | "description" | "dataClass" | "impact" | "cacheTtl">> {
    return [...this.skills.values()].map((s) => ({
      name: s.name,
      version: s.version,
      description: s.description,
      dataClass: s.dataClass,
      impact: s.impact,
      cacheTtl: s.cacheTtl,
    }));
  }
}

/**
 * SKILLS ACTIVES À CE JOUR.
 *
 * Sur nos propres données, sans aucune clé :
 *   product.analyze            lecture d'ensemble d'un produit
 *   product.price.recommend    prix unique borné par la marge visée
 *   product.restock.recommend  quantité et urgence de réapprovisionnement
 *   metrics.anomaly.detect     jours de vente hors norme
 *
 * Sur le marché extérieur — fonctionnent sans clé mais ne trouveront alors que
 * nos propres données, la recherche web étant la seule couche à exiger Gemini :
 *   market.price.research      à quel prix ce produit se vend ailleurs
 *   supplier.find              qui le fournit, et à quel prix unitaire
 *
 * À VENIR, sur ce même socle, sans changer l'architecture :
 *   identité visuelle (image.product.describe, product.visual.compare),
 *   étiquetage des messages et avis (nécessite d'abord de les collecter).
 */
export function defaultSkills(): SkillRegistry {
  return new SkillRegistry()
    .register(productAnalyze as Skill)
    .register(priceRecommend as Skill)
    .register(restockRecommend as Skill)
    .register(anomalyDetect as Skill)
    .register(marketResearch as Skill)
    .register(supplierFind as Skill);
}
