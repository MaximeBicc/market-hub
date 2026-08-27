import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  ebayEnsureNotifications,
  shopifyEnsureWebhooks,
  type EbayAdapter,
  type ShopifyAdapter,
} from "@hub/engine";
import { shop } from "../db/schema.js";
import type { Env } from "../env.js";
import { buildEngine } from "../engine/module.js";
import { d1Repositories } from "../engine/repositories.js";
import { ensureSyncJobs } from "../engine/sync.js";

/**
 * LE TEMPS RÉEL NE DOIT PAS ÊTRE UN BOUTON QU'ON OUBLIE.
 *
 * L'abonnement aux webhooks Shopify était un geste manuel, dans un écran
 * qu'on ne rouvre pas. Une boutique connectée et oubliée dans cet état reste
 * relevée toutes les deux minutes : environ 1 440 tâches par jour, contre 192
 * une fois abonnée. Sept fois plus, pour une fraîcheur SEPT FOIS PIRE — le
 * webhook arrive en quelques secondes, le relevé en deux minutes.
 *
 * L'abonnement devient donc automatique : à la connexion, et rattrapé chaque
 * heure pour les boutiques déjà en place. Le bouton reste, pour forcer un
 * réabonnement après un changement d'adresse de rappel.
 */

export interface RapportTempsReel {
  /** Sujets nouvellement abonnés. */
  crees: string[];
  /** Sujets déjà abonnés — un réabonnement ne crée pas de doublon. */
  dejaLa: string[];
  echecs: Array<{ topic: string; message: string }>;
  rappel: string;
}

/**
 * Abonne un compte Shopify aux webhooks, et détend son relevé.
 *
 * Idempotent : Shopify rend les abonnements existants plutôt que de les
 * dupliquer, et un second passage se contente de les constater.
 */
export async function activerTempsReel(
  env: Env,
  accountId: string,
): Promise<RapportTempsReel> {
  const repos = d1Repositories(env.DB, env.MASTER_KEY);
  const account = await repos.accounts.get(accountId);
  if (!account) throw new Error("Boutique inconnue");
  if (account.marketplace === "ebay") return activerNotificationsEbay(env, accountId);
  if (account.marketplace !== "shopify") {
    throw new Error(
      `${account.marketplace} n'expose pas d'abonnement aux webhooks par l'API.`,
    );
  }

  const mod = buildEngine(env);
  const adaptateur = mod.registry.get("shopify") as ShopifyAdapter;
  const rappel = `${env.APP_URL.replace(/\/+$/, "")}/api/webhooks/shopify`;

  /*
   * Le crédential est muté SUR PLACE, jamais recopié.
   *
   * `saveCredentials` reçoit un correctif ; l'appliquer à une copie figée
   * ferait que le second appel de la séquence rejouerait le jeton d'avant.
   * C'est un piège qui a déjà coûté une reconnexion Etsy.
   */
  const credentials = { ...(await repos.credentials.get(accountId)) };

  const rapport = await shopifyEnsureWebhooks(
    adaptateur,
    {
      account,
      credentials,
      http: mod.httpFor(account),
      saveCredentials: async (patch) => {
        Object.assign(credentials, patch);
        await repos.credentials.put(accountId, credentials);
      },
    },
    rappel,
  );

  const poses = rapport.crees.length + rapport.dejaLa.length;
  if (poses > 0) {
    const frais = await repos.credentials.get(accountId);
    await repos.credentials.put(accountId, { ...frais, webhooksActifs: "1" });
    // Le relevé devient un filet : de deux minutes à un quart d'heure.
    await ensureSyncJobs(env, accountId);
  }

  return { ...rapport, rappel };
}

/**
 * Rattrape les boutiques Shopify qui poussent sans le savoir.
 *
 * Appelée chaque heure. Elle ne parle à Shopify que pour les comptes dont
 * l'abonnement n'est PAS déjà marqué actif : une fois la flotte à jour, ce
 * passage ne coûte qu'une lecture de base.
 *
 * Les échecs sont avalés à dessein. Une portée `write_webhooks` manquante ou
 * un jeton fatigué ne doit pas interrompre le renouvellement des jetons qui
 * suit dans le même déclencheur — et la boutique continue d'être relevée,
 * simplement plus souvent.
 */
export async function rattraperTempsReel(env: Env): Promise<{
  examines: number;
  actives: string[];
  echecs: string[];
}> {
  const db = drizzle(env.DB);
  const repos = d1Repositories(env.DB, env.MASTER_KEY);

  const boutiques = await db
    .select({ id: shop.id, nom: shop.displayName })
    .from(shop)
    .where(eq(shop.platform, "shopify"));

  const actives: string[] = [];
  const echecs: string[] = [];

  for (const b of boutiques) {
    const creds = await repos.credentials.get(b.id);
    if (creds?.["webhooksActifs"] === "1") continue;

    try {
      const r = await activerTempsReel(env, b.id);
      if (r.crees.length + r.dejaLa.length > 0) actives.push(b.nom);
      else echecs.push(`${b.nom} : aucun abonnement posé`);
    } catch (err) {
      echecs.push(
        `${b.nom} : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { examines: boutiques.length, actives, echecs };
}

/**
 * Abonne un compte eBay aux notifications de vente.
 *
 * Trois pièces doivent exister avant qu'eBay pousse quoi que ce soit : une
 * adresse d'alerte, une destination vérifiée, et un abonnement par sujet. La
 * séquence vit dans l'adaptateur ; ici on lui fournit le décor et on note le
 * résultat.
 */
async function activerNotificationsEbay(
  env: Env,
  accountId: string,
): Promise<RapportTempsReel> {
  const repos = d1Repositories(env.DB, env.MASTER_KEY);
  const account = await repos.accounts.get(accountId);
  if (!account) throw new Error("Boutique inconnue");

  const jeton = env.EBAY_VERIFICATION_TOKEN ?? "";
  if (!jeton) {
    throw new Error(
      "EBAY_VERIFICATION_TOKEN manquant. C'est lui qui prouve à eBay que l'adresse de rappel est bien la nôtre.",
    );
  }

  const mod = buildEngine(env);
  const adaptateur = mod.registry.get("ebay") as EbayAdapter;
  /*
   * L'adresse doit être IDENTIQUE, caractère pour caractère, à celle que la
   * route de défi utilise pour son calcul. Un écart — une barre oblique de
   * plus — et eBay refuse l'enregistrement sans dire pourquoi.
   */
  const rappel = `${env.APP_URL.replace(/\/+$/, "")}/api/webhooks/ebay`;

  const credentials = { ...(await repos.credentials.get(accountId)) };
  const rapport = await ebayEnsureNotifications(
    adaptateur,
    {
      account,
      credentials,
      http: mod.httpFor(account),
      saveCredentials: async (patch) => {
        Object.assign(credentials, patch);
        await repos.credentials.put(accountId, credentials);
      },
    },
    rappel,
    jeton,
    // eBay exige une adresse où prévenir quand la livraison échoue. La nôtre
    // sert aussi de trace : sans alerte, un abonnement mort passe inaperçu.
    "support@variety.boutique",
  );

  const poses = rapport.crees.length + rapport.dejaLa.length;
  if (poses > 0) {
    const frais = await repos.credentials.get(accountId);
    await repos.credentials.put(accountId, {
      ...frais,
      notificationsActives: "1",
    });
    // La capacité bascule en « poussée » : le relevé devient un filet.
    await ensureSyncJobs(env, accountId);
  }

  return { ...rapport, rappel };
}