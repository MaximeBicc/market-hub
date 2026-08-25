import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { desc, eq } from "drizzle-orm";
import type {
  CapabilitySet,
  MarketplaceAdapter,
  MarketplaceContext,
} from "@hub/engine";
import { COMMANDES, etatCommande } from "@hub/engine";
import { inventory, listing, shop, syncJob, webhookReceipt } from "../db/schema.js";
import type { Env } from "../env.js";
import { buildEngine } from "../engine/module.js";
import { d1Repositories } from "../engine/repositories.js";
import { authenticate } from "../lib/session.js";
import { getValidAccessToken } from "../lib/tokens.js";
import { signRequest } from "@hub/connectors";
import type { RateLimiter } from "../do/rate-limiter.js";

/**
 * DIAGNOSTIC EN LECTURE SEULE.
 *
 * Répond à une question que rien d'autre ne tranche : « est-ce que mes
 * boutiques sont VRAIMENT reliées ? » Une synchronisation qui se déclare en
 * succès et ne rapporte aucune annonce peut vouloir dire deux choses
 * opposées — la boutique est vide, ou on ne sait pas la lire. Le tableau de
 * bord affiche zéro dans les deux cas.
 *
 * ═══ POURQUOI IL NE PEUT PAS ÉCRIRE ═══
 *
 * Pas par prudence, par construction. L'adaptateur n'est jamais manipulé
 * directement : il est d'abord réduit au type `LectureSeule`, qui n'expose que
 * quatre méthodes. Appeler `createListing`, `updateStock` ou `rawGql` depuis
 * ce fichier ne serait pas une imprudence à repérer en relecture — ce serait
 * une erreur de compilation.
 *
 * Cette précaution vise un piège précis : `ShopifyAdapter.rawGql` est publique
 * et son nom ne dit rien de ce qu'elle fait. Elle exécute aussi bien une
 * lecture qu'une mutation. Un diagnostic qui filtrerait « par nom de méthode
 * qui a l'air inoffensif » passerait à côté.
 *
 * ═══ CE QUI PART SUR LE RÉSEAU ═══
 *
 * Trois lectures par boutique, plus le renouvellement du jeton d'accès si
 * nécessaire. Le renouvellement est un POST, mais vers le point d'authen-
 * tification : il ne touche ni annonce, ni stock, ni commande.
 *
 * Ce renouvellement est le SEUL effet distant possible, et il est conservé
 * volontairement : chez Etsy il consomme le jeton de rafraîchissement et le
 * remplace. Le nouveau doit donc être enregistré, sinon la boutique devient
 * injoignable. Un diagnostic qui refuserait d'écrire quoi que ce soit
 * casserait précisément ce qu'il vient vérifier.
 *
 * Le tout passe par `httpFor`, donc par le seau à jetons du compte. Un
 * diagnostic lancé en boucle ne peut pas faire dépasser le débit autorisé
 * par une plateforme — c'est ce qui coûterait un bannissement.
 *
 * ═══ CE QU'IL NE DIVULGUE JAMAIS ═══
 *
 * Aucune valeur d'identifiant. Les jetons sont rapportés par leur PRÉSENCE et
 * leur échéance, jamais par leur contenu, même tronqué.
 */

export const diagnostic = new Hono<{ Bindings: Env }>();

/**
 * Session, ou jeton dédié.
 *
 * Le jeton permet d'interroger l'état sans navigateur — utile pour vérifier un
 * déploiement. Il est distinct de celui du panel d'IA : deux surfaces, deux
 * jetons, deux révocations indépendantes. Absent, la porte se ferme.
 */
diagnostic.use("*", async (c, next) => {
  const me = await authenticate(c.env, c.req.raw);
  if (me) return next();

  const propose = c.req.header("x-diagnostic-token");
  const attendu = c.env.MARKETS_DIAGNOSTIC_TOKEN;
  if (attendu && propose && egalesEnTempsConstant(propose, attendu)) {
    return next();
  }
  return c.json({ error: "unauthorized" }, 401);
});

function egalesEnTempsConstant(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * La vue réduite d'un adaptateur : quatre méthodes, toutes en lecture.
 *
 * C'est la garantie centrale de ce fichier. Le compilateur refuse tout le
 * reste — y compris les portes dérobées qui ne se voient pas au nom.
 */
type LectureSeule = Pick<
  MarketplaceAdapter,
  | "id"
  | "capabilities"
  | "testConnection"
  | "fetchListings"
  | "pollOrderEvents"
  // Lecture pure elle aussi : elle liste les politiques et profils du compte
  // marchand, et n'en crée jamais.
  | "listSettings"
>;

/**
 * Plafond de sous-requêtes avant d'arrêter de sonder.
 *
 * Cloudflare en autorise 50 par invocation, le transport s'en réserve 40. Une
 * lecture eBay coûte un appel par SKU en plus de la page : trois boutitques
 * fournies peuvent donc s'en approcher. On s'arrête avant, et on le DIT dans
 * la réponse — une troncature silencieuse se lirait comme « tout va bien ».
 */
const ARRET_SONDAGE = 30;

interface Chrono {
  ms: number;
}

async function mesure<T>(f: () => Promise<T>): Promise<[T, Chrono]> {
  const t0 = Date.now();
  const r = await f();
  return [r, { ms: Date.now() - t0 }];
}

function erreurLisible(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Échéance en secondes, ou null si la donnée n'existe pas. */
function restant(valeur: string | undefined, maintenant: number): number | null {
  const n = Number(valeur);
  return valeur && Number.isFinite(n) && n > 0 ? n - maintenant : null;
}

diagnostic.get("/", async (c) => {
  const db = drizzle(c.env.DB);
  const repos = d1Repositories(c.env.DB, c.env.MASTER_KEY);
  const compteur = { used: 0 };
  const mod = buildEngine(c.env, compteur);
  const maintenant = Math.floor(Date.now() / 1000);

  /* ---- Catalogue générique : ce que chaque adaptateur sait faire ---- */
  const adaptateurs = [];
  for (const a of mod.registry.list()) {
    adaptateurs.push({
      id: a.id,
      // Compte fictif, sans identifiants : on lit la capacité NUE de
      // l'adaptateur, celle qui ne dépend d'aucune configuration.
      capacites: await a.capabilities({
        account: {
          id: "catalogue",
          marketplace: a.id,
          slug: "catalogue",
          displayName: "catalogue",
          enabled: true,
        },
      }),
      lectureCatalogue: typeof a.fetchListings === "function",
      releveVentes: typeof a.pollOrderEvents === "function",
      webhooks: typeof a.verifyAndParseWebhook === "function",
    });
  }

  /* ---- Une passe par boutique ---------------------------------------- */
  const lignes = await db.select().from(shop).orderBy(shop.platform);
  const boutiques = [];
  let interrompu: string | null = null;

  for (const s of lignes) {
    if (compteur.used >= ARRET_SONDAGE) {
      interrompu = `Sondage arrêté avant « ${s.displayName} » : ${compteur.used} sous-requêtes déjà consommées sur les 40 disponibles. Relancez pour couvrir les boutiques restantes.`;
      break;
    }

    const account = await repos.accounts.get(s.id);
    if (!account) continue;

    // Copie MUTABLE, et non l'instantané figé : voir la note sur
    // `saveCredentials` plus bas, c'est ce qui empêche Etsy d'être brûlé.
    const credentials = { ...(await repos.credentials.get(s.id)) };
    const adapter = mod.registry.get(account.marketplace);

    // Réduction au contrat de lecture. Tout ce qui suit ne voit plus que ça.
    const lecture: LectureSeule = adapter;

    const ctx: MarketplaceContext = {
      account,
      credentials,
      // Le fetch régulé : ce diagnostic ne doit pas pouvoir dépasser le débit
      // qu'une plateforme autorise, même lancé en rafale. Sur Etsy il protège
      // en plus d'un second essai de renouvellement avec un jeton déjà mort :
      // le transport lève sur le premier refus au lieu de rejouer.
      http: mod.httpFor(account),

      /*
       * PRÉSENT, ET C'EST VITAL — même pour un diagnostic en lecture seule.
       *
       * Le premier jet de ce fichier omettait ce rappel, en croyant bien
       * faire : « pas de rappel d'écriture, donc rien ne peut être réécrit ».
       * C'était exactement l'inverse.
       *
       * Les adaptateurs renouvellent leur jeton d'accès de façon transparente,
       * y compris pendant une lecture. Or Etsy fait TOURNER son jeton de
       * rafraîchissement : l'ancien meurt à l'instant où le nouveau est
       * délivré. Sans ce rappel, l'appel optionnel `saveCredentials?.()` ne
       * fait rien, le nouveau jeton part à la poubelle — et la boutique est
       * définitivement injoignable, à réautoriser au navigateur.
       *
       * Une sonde « sans écriture » aurait donc cassé Etsy à la première
       * exécution suivant l'expiration du jeton d'accès, c'est-à-dire au bout
       * d'une heure.
       */
      saveCredentials: async (patch) => {
        Object.assign(credentials, patch);
        await repos.credentials.put(s.id, credentials);
      },
    };

    const capacites: CapabilitySet = await lecture.capabilities(ctx);

    /* -- Test 1 : la connexion répond-elle ? -- */
    let connexion: Record<string, unknown>;
    try {
      const [, t] = await mesure(() => lecture.testConnection(ctx));
      connexion = { ok: true, ms: t.ms };
    } catch (err) {
      connexion = { ok: false, erreur: erreurLisible(err) };
    }

    /* -- Test 2 : le catalogue se lit-il ? -- */
    let catalogue: Record<string, unknown>;
    if (!lecture.fetchListings) {
      catalogue = { ok: false, raison: "lecture non gérée par l'adaptateur" };
    } else {
      try {
        const [page, t] = await mesure(() => lecture.fetchListings!(ctx));
        catalogue = {
          ok: true,
          ms: t.ms,
          lus: page.items.length,
          autresPages: Boolean(page.cursor),
          sansSku: page.items.filter((i) => !i.sku).length,
          // La distinction qui compte : zéro annonce lue SANS erreur signifie
          // que la boutique est vide, pas qu'on est aveugle.
          verdict:
            page.items.length === 0
              ? "la plateforme a répondu, et n'a aucune annonce à montrer"
              : `${page.items.length} annonce(s) lue(s)`,
          exemples: page.items.slice(0, 5).map((i) => ({
            sku: i.sku,
            titre: i.title,
            prix: i.price.amount / 100,
            devise: i.price.currency,
            stock: i.stock,
            statut: i.status,
          })),
        };
      } catch (err) {
        catalogue = { ok: false, erreur: erreurLisible(err) };
      }
    }

    /* -- Test 3 : les ventes se relèvent-elles ? -- */
    let ventes: Record<string, unknown>;
    if (!lecture.pollOrderEvents) {
      ventes = { ok: false, raison: "relevé non géré par l'adaptateur" };
    } else {
      try {
        const [page, t] = await mesure(() => lecture.pollOrderEvents!(ctx));
        ventes = {
          ok: true,
          ms: t.ms,
          lues: page.events.length,
          autresPages: Boolean(page.cursor),
          exemples: page.events.slice(0, 3).map((e) => ({
            commande: e.remoteOrderId,
            type: e.kind,
            date: e.occurredAt,
            lignes: e.lines.length,
          })),
        };
      } catch (err) {
        ventes = { ok: false, erreur: erreurLisible(err) };
      }
    }

    /* -- Réglages de compte : ce que la plateforme propose vraiment -- */
    /*
     * Distinguer deux situations que « bloquée » confond : la plateforme n'a
     * RIEN à proposer — l'objet n'existe pas encore côté marchand — ou elle en
     * propose et personne ne les a choisis dans l'outil. Sans ce détail, on ne
     * sait pas s'il faut aller créer une politique ou juste cliquer.
     */
    let reglages: Record<string, unknown>;
    if (!lecture.listSettings) {
      reglages = { ok: true, exige: false };
    } else {
      try {
        const liste = await lecture.listSettings(ctx);
        reglages = {
          ok: true,
          exige: true,
          details: liste.map((r) => ({
            cle: r.key,
            libelle: r.label,
            proposes: r.options.length,
            exemples: r.options.slice(0, 3).map((o) => o.label),
            choisi: Boolean(credentials[r.key]),
          })),
        };
      } catch (err) {
        reglages = { ok: false, erreur: erreurLisible(err) };
      }
    }

    /* -- Jetons : présence et échéance, jamais la valeur -- */
    const c2 = credentials ?? {};
    const accesDans = restant(c2["accessTokenExpiresAt"], maintenant);
    const obtenu = Number(c2["refreshTokenObtainedAt"]);
    const rafraichissementDans =
      restant(c2["refreshTokenExpiresAt"], maintenant) ??
      (Number.isFinite(obtenu) && obtenu > 0
        ? obtenu + 90 * 86400 - maintenant
        : null);

    /* -- Ce que la base locale contient pour cette boutique -- */
    const local = await db
      .select({
        externalId: listing.externalId,
        productId: listing.productId,
        quantity: listing.quantity,
      })
      .from(listing)
      .where(eq(listing.shopId, s.id));

    /* -- Santé des tâches de synchronisation -- */
    const jobs = await db
      .select()
      .from(syncJob)
      .where(eq(syncJob.shopId, s.id));

    /* -- Dernier webhook réellement reçu -- */
    const dernierWebhook = await db
      .select({ at: webhookReceipt.receivedAt, topic: webhookReceipt.topic })
      .from(webhookReceipt)
      .where(eq(webhookReceipt.shopId, s.id))
      .orderBy(desc(webhookReceipt.receivedAt))
      .limit(1);

    const poussePossible =
      capacites.inboundSales === "webhook" || capacites.inboundSales === "both";

    boutiques.push({
      // LE CATALOGUE : commande par commande, ce que ce compte peut faire, et
      // ce qui manque quand il ne peut pas. C'est la réponse à « qu'est-ce qui
      // est possible ? », posée boutique par boutique plutôt qu'en général.
      commandes: COMMANDES.map((cmd) => ({
        id: cmd.id,
        libelle: cmd.libelle,
        ecrit: cmd.ecrit,
        portee: cmd.portee,
        ...etatCommande(cmd, account.marketplace, capacites, credentials),
      })),
      identite: {
        id: s.id,
        plateforme: s.platform,
        nom: s.displayName,
        identifiantDistant: s.externalId,
        statut: s.status,
        relieeDepuis: s.connectedAt,
      },
      capacites,
      lecture: { connexion, catalogue, ventes },
      reglages,
      jetons: {
        accesExpireDansSec: accesDans,
        rafraichissementExpireDansJours:
          rafraichissementDans === null
            ? null
            : Math.round(rafraichissementDans / 86400),
        // Présence seule. Une clé partiellement affichée reste une clé divulguée.
        clesPresentes: Object.keys(c2).sort(),
      },
      local: {
        annonces: local.length,
        sansProduitMaitre: local.filter((l) => !l.productId).length,
        stockTotal: local.reduce((n, l) => n + l.quantity, 0),
      },
      synchronisation: jobs.map((j) => ({
        ressource: j.resource,
        intervalleSec: j.intervalSec,
        active: j.enabled === 1,
        echecs: j.failureCount,
        derniereReussiteIlYaSec: j.lastOkAt ? maintenant - j.lastOkAt : null,
        enRetardSec: Math.max(0, maintenant - j.nextRunAt),
        curseurEnCours: Boolean(j.cursor),
        derniereErreur: j.lastError,
      })),
      tempsReel: {
        poussePossible,
        abonnementActif: c2["webhooksActifs"] === "1",
        secretPresent: Boolean(c2["webhookSecret"] || c2["clientSecret"]),
        dernierWebhookRecuIlYaSec: dernierWebhook[0]
          ? maintenant - dernierWebhook[0].at
          : null,
        // Le cas trompeur : la plateforme SAIT pousser, on croit le temps réel
        // actif, et rien n'a jamais été souscrit.
        avertissement:
          poussePossible && c2["webhooksActifs"] !== "1"
            ? "Cette plateforme sait pousser ses événements, mais aucun abonnement n'a été créé. Le relevé tourne toutes les 2 minutes à la place."
            : null,
      },
    });
  }

  /* ---- Stock central, partagé entre boutiques ------------------------ */
  const stock = await db
    .select({ onHand: inventory.onHand, version: inventory.version })
    .from(inventory);

  return c.json({
    genere: maintenant,
    sousRequetes: { consommees: compteur.used, plafond: 40 },
    ...(interrompu ? { interrompu } : {}),
    adaptateurs,
    boutiques,
    stockCentral: {
      produitsSuivis: stock.length,
      unites: stock.reduce((n, i) => n + i.onHand, 0),
    },
  });
});

/**
 * LA SONDE ALIBABA — l'appel qui tranche une question ouverte.
 *
 * Toute l'intégration Alibaba dépend d'une inconnue que la documentation ne
 * lève pas : `/alibaba/order/list` rend-elle les commandes passées À LA MAIN
 * sur alibaba.com, ou seulement celles créées par l'API ? Les indices penchent
 * pour la première — l'API expose des statuts qu'aucun appel ne peut produire
 * — mais personne ne l'a publiquement éprouvé.
 *
 * Construire l'adaptateur avant de savoir, c'est risquer de tout jeter. Cette
 * route fait l'appel, une fois, et rend la réponse BRUTE. Elle ne mappe rien :
 * l'intérêt est justement de voir ce qu'Alibaba dit, mot pour mot.
 *
 * LECTURE SEULE, par construction : un seul chemin est appelable, celui de la
 * liste. Aucun paramètre du client ne choisit l'endpoint.
 *
 * Piège relevé dans la documentation : les dates de cette API sont exprimées
 * en fuseau America/Los_Angeles, pas en UTC. Une fenêtre calculée en UTC
 * manquerait les commandes des dernières heures.
 */
diagnostic.get("/alibaba/commandes", async (c) => {
  const db = drizzle(c.env.DB);

  const [boutique] = await db
    .select({ id: shop.id, nom: shop.displayName })
    .from(shop)
    .where(eq(shop.platform, "alibaba"))
    .limit(1);

  if (!boutique) {
    return c.json(
      {
        etat: "non_connecte",
        explication:
          "Aucune boutique Alibaba en base. Passez d'abord par /api/oauth/alibaba/start, connecté à l'application.",
      },
      200,
    );
  }

  let jeton: string;
  try {
    const stub = c.env.RATE_LIMITER.get(
      c.env.RATE_LIMITER.idFromName(boutique.id),
    ) as DurableObjectStub<RateLimiter>;
    const resolu = await getValidAccessToken(c.env, boutique.id, stub);
    jeton = resolu.accessToken;
  } catch (err) {
    return c.json(
      {
        etat: "jeton_indisponible",
        detail: err instanceof Error ? err.message : String(err),
      },
      200,
    );
  }

  /*
   * PLUSIEURS FORMATS, UN SEUL ALLER-RETOUR.
   *
   * Le premier essai a rendu « null#create_date_start is not valid » : la
   * signature, le jeton et la permission passent, seul le format de la date
   * est refusé. Alibaba ne le documente pas ici, et deviner un format à
   * chaque déploiement coûterait une demi-journée.
   *
   * On essaie donc les candidats en série, en s'arrêtant au premier accepté.
   * Le PREMIER de la liste est le plus important : SANS aucune date. Si les
   * bornes sont facultatives, la question de fond — les commandes passées à
   * la main remontent-elles ? — trouve sa réponse tout de suite, et le format
   * n'a plus d'importance.
   *
   * Chaque essai est un appel de liste. Sept essais restent loin sous les
   * cinquante sous-requêtes du plan gratuit.
   */
  const jours = Number(c.req.query("jours") ?? 365);
  const fin = new Date();
  const debut = new Date(fin.getTime() - jours * 86_400_000);

  /** L'heure de Los Angeles, découpée — cette API n'est pas en UTC. */
  const parts = (d: Date) => {
    const f = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const g = (t: string) => f.find((p) => p.type === t)?.value ?? "00";
    return {
      date: `${g("year")}-${g("month")}-${g("day")}`,
      heure: `${g("hour")}:${g("minute")}:${g("second")}`,
    };
  };
  const a = parts(debut);
  const b = parts(fin);

  const essais: Array<{ nom: string; bornes: Record<string, string> }> = [
    { nom: "sans date", bornes: {} },
    {
      nom: "espace : 2026-01-31 12:00:00",
      bornes: {
        create_date_start: `${a.date} ${a.heure}`,
        create_date_end: `${b.date} ${b.heure}`,
      },
    },
    {
      nom: "ISO avec décalage : 2026-01-31T12:00:00-0800",
      bornes: {
        create_date_start: `${a.date}T${a.heure}-0800`,
        create_date_end: `${b.date}T${b.heure}-0800`,
      },
    },
    {
      nom: "ISO avec décalage à deux-points : ...-08:00",
      bornes: {
        create_date_start: `${a.date}T${a.heure}-08:00`,
        create_date_end: `${b.date}T${b.heure}-08:00`,
      },
    },
    {
      nom: "ISO UTC : 2026-01-31T12:00:00Z",
      bornes: {
        create_date_start: `${a.date}T${a.heure}Z`,
        create_date_end: `${b.date}T${b.heure}Z`,
      },
    },
    {
      nom: "date seule : 2026-01-31",
      bornes: { create_date_start: a.date, create_date_end: b.date },
    },
    {
      nom: "millisecondes depuis epoch",
      bornes: {
        create_date_start: String(debut.getTime()),
        create_date_end: String(fin.getTime()),
      },
    },
  ];

  const chemin = "/alibaba/order/list";
  const journal: Array<{
    essai: string;
    accepte: boolean;
    reponse: string;
  }> = [];

  for (const essai of essais) {
    const parametres: Record<string, string> = {
      app_key: c.env.ALIBABA_APP_KEY,
      timestamp: String(Date.now()),
      sign_method: "sha256",
      access_token: jeton,
      role: "buyer",
      page_size: "20",
      current_page: "1",
      ...essai.bornes,
    };
    parametres["sign"] = await signRequest(
      chemin,
      parametres,
      c.env.ALIBABA_APP_SECRET,
    );

    const reponse = await fetch(
      `https://openapi-api.alibaba.com/rest${chemin}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(parametres),
      },
    );
    const texte = await reponse.text();

    /*
     * La passerelle répond 200 même sur refus : c'est le corps qui tranche.
     *
     * L'erreur est un objet PLAT en tête de réponse — {"type":"ISV","code":
     * "InvalidParameter",...}. On ne regarde donc que les deux cents premiers
     * caractères : un « code » niché dans les données d'une commande (un code
     * pays, un code de statut) ne doit pas se faire prendre pour un refus.
     */
    const enTete = texte.slice(0, 200);
    const accepte = !/"code"\s*:\s*"(?!0")[A-Za-z]/.test(enTete);
    journal.push({
      essai: essai.nom,
      accepte,
      reponse: texte.slice(0, 2500),
    });

    // Un format accepté suffit : inutile de brûler les suivants.
    if (accepte) break;
  }

  const gagnant = journal.find((e) => e.accepte);

  return c.json({
    boutique: boutique.nom,
    fenetre: {
      debut: `${a.date} ${a.heure}`,
      fin: `${b.date} ${b.heure}`,
      fuseau: "America/Los_Angeles",
    },
    formatAccepte: gagnant?.essai ?? null,
    essais: journal,
  });
});
