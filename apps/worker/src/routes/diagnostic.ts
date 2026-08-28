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
        /*
         * La réponse vient du module, pas d'une liste de drapeaux tenue ici.
         * Chaque plateforme nomme le sien autrement, et cet écran est celui
         * qui sert à vérifier le reste : il ne peut pas être celui qui oublie
         * une plateforme de plus à chaque ajout.
         */
        abonnementActif: capacites.pousseActive,
        secretPresent: Boolean(c2["webhookSecret"] || c2["clientSecret"]),
        dernierWebhookRecuIlYaSec: dernierWebhook[0]
          ? maintenant - dernierWebhook[0].at
          : null,
        // Le cas trompeur : la plateforme SAIT pousser, on croit le temps réel
        // actif, et rien n'a jamais été souscrit.
        avertissement:
          poussePossible && !capacites.pousseActive
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
   * LES PARAMÈTRES, TELS QUE L'EXPLORATEUR D'API LES DÉCRIT.
   *
   * Cinq formats de date avaient été refusés du même message,
   * « null#create_date_start ». Ce n'était pas un problème de format : ce
   * paramètre est un OBJET, porteur de `date_str` ou de `date_timestamp`.
   * Le préfixe « null# » désignait le parent manquant, pas la valeur.
   *
   * Deux autres écarts relevés au passage :
   *   - la pagination s'appelle `start_page`, pas `current_page` ; le nôtre
   *     était ignoré en silence, ce qui rendait la pagination inopérante ;
   *   - `page_size` vaut 10 par défaut, et cent au plus.
   *
   * Les heures sont celles de America/Los_Angeles — la documentation le
   * répète sur chacun des quatre champs de date.
   */
  const jours = Number(c.req.query("jours") ?? 365);
  const maintenant = new Date();
  const depuis = new Date(maintenant.getTime() - jours * 86_400_000);

  /** `yyyy-MM-dd HH:mm:ss` à l'heure de Los Angeles, le format documenté. */
  const losAngeles = (d: Date) => {
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
    return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
  };

  const debutStr = losAngeles(depuis);
  const finStr = losAngeles(maintenant);

  // L'objet imbriqué voyage en JSON dans son champ de formulaire. La
  // signature porte sur ce texte tel quel.
  const parDate = {
    create_date_start: JSON.stringify({ date_str: debutStr }),
    create_date_end: JSON.stringify({ date_str: finStr }),
  };
  const parHorodatage = {
    create_date_start: JSON.stringify({ date_timestamp: depuis.getTime() }),
    create_date_end: JSON.stringify({ date_timestamp: maintenant.getTime() }),
  };

  const essais: Array<{ nom: string; sup: Record<string, string> }> = [
    {
      nom: "buyer + dates objet (date_str) + start_page",
      sup: { role: "buyer", start_page: "0", page_size: "50", ...parDate },
    },
    {
      nom: "buyer + dates objet (date_timestamp)",
      sup: { role: "buyer", start_page: "0", page_size: "50", ...parHorodatage },
    },
    {
      nom: "seller + dates objet (date_str)",
      sup: { role: "seller", start_page: "0", page_size: "50", ...parDate },
    },
    // La pagination commence-t-elle à zéro ou à un ? La doc dit « défaut 0 »,
    // mais un décalage d'un rang est une cause classique de liste vide.
    {
      nom: "buyer + dates objet, start_page=1",
      sup: { role: "buyer", start_page: "1", page_size: "50", ...parDate },
    },
    // Sans date mais avec la BONNE pagination : le premier essai passait
    // `current_page`, un nom qu'Alibaba ignore.
    {
      nom: "buyer + start_page correct, sans date",
      sup: { role: "buyer", start_page: "0", page_size: "50" },
    },
    // Un statut connu, au cas où la liste exigerait un filtre.
    {
      nom: "buyer + statut unpay",
      sup: { role: "buyer", start_page: "0", page_size: "50", status: "unpay" },
    },
  ];

  const chemin = "/alibaba/order/list";
  const journal: Array<{ essai: string; vide: boolean; reponse: string }> = [];

  for (const essai of essais) {
    const parametres: Record<string, string> = {
      app_key: c.env.ALIBABA_APP_KEY,
      timestamp: String(Date.now()),
      sign_method: "sha256",
      access_token: jeton,
      ...essai.sup,
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
     * « value » entièrement vide n'est PAS la même chose qu'une liste vide.
     * Une requête qui s'exécute sans rien trouver rendrait `total_count: 0`.
     * Un objet vide dit plutôt qu'elle n'a pas tourné comme on croit.
     */
    const vide = /"value"\s*:\s*\{\s*\}/.test(texte);
    journal.push({ essai: essai.nom, vide, reponse: texte.slice(0, 1500) });

    if (!vide && texte.includes('"code":"0"')) break;
  }

  const trouve = journal.find(
    (e) => !e.vide && e.reponse.includes('"code":"0"'),
  );

  return c.json({
    boutique: boutique.nom,
    fenetre: { debut: debutStr, fin: finStr, fuseau: "America/Los_Angeles" },
    essaiQuiRendQuelqueChose: trouve?.essai ?? null,
    essais: journal,
  });
});


/**
 * LA FICHE D'UN PRODUIT FOURNISSEUR, PAR SON LIEN OU SON IDENTIFIANT.
 *
 * C'est la moitié utile d'Alibaba qui ne dépend pas de l'historique d'achat :
 * `/eco/buyer/product/description` rend le titre, la description, toutes les
 * photos en URL publiques, les déclinaisons avec leur propre image, et le
 * prix de revient DÉBARQUÉ — marchandise plus fret jusqu'en France.
 *
 * Deux pièges que cette route enjambe :
 *
 *   1. `query_req` est un OBJET, comme les dates de la liste de commandes.
 *      Envoyer `product_id` à plat vaudrait « null#product_id is not valid ».
 *   2. `ship_to_country` n'est pas décoratif : la documentation dit qu'il est
 *      « essential for calculating the cost price ». Sans lui, le fret est
 *      calculé pour un ailleurs, et la marge affichée est fausse.
 *
 * Lecture seule : un seul chemin, aucun paramètre du client ne le choisit.
 */
diagnostic.get("/alibaba/produit", async (c) => {
  const db = drizzle(c.env.DB);

  const [boutique] = await db
    .select({ id: shop.id })
    .from(shop)
    .where(eq(shop.platform, "alibaba"))
    .limit(1);
  if (!boutique) return c.json({ etat: "non_connecte" }, 200);

  /*
   * L'identifiant se lit aussi bien dans un lien que seul.
   *
   * Les liens Alibaba portent l'identifiant en fin de chemin, précédé d'un
   * tiret bas : .../product-detail/Sublimation-Mug_1601206892606.html
   * On accepte donc l'un ou l'autre — coller l'adresse de la page est ce
   * qu'on fait naturellement.
   */
  const brut = (c.req.query("id") ?? "").trim();
  const trouve = brut.match(/(\d{10,})/);
  if (!trouve) {
    return c.json(
      {
        erreur:
          "Passez ?id= avec un identifiant produit Alibaba, ou l'adresse complète de sa page.",
      },
      400,
    );
  }
  const productId = trouve[1]!;

  let jeton: string;
  try {
    const stub = c.env.RATE_LIMITER.get(
      c.env.RATE_LIMITER.idFromName(boutique.id),
    ) as DurableObjectStub<RateLimiter>;
    jeton = (await getValidAccessToken(c.env, boutique.id, stub)).accessToken;
  } catch (err) {
    return c.json(
      {
        etat: "jeton_indisponible",
        detail: err instanceof Error ? err.message : String(err),
      },
      200,
    );
  }

  const chemin = "/eco/buyer/product/description";
  const parametres: Record<string, string> = {
    app_key: c.env.ALIBABA_APP_KEY,
    timestamp: String(Date.now()),
    sign_method: "sha256",
    access_token: jeton,
    query_req: JSON.stringify({
      product_id: Number(productId),
      country: "FR",
      language: "fr-FR",
      currency: "EUR",
      // Le fret jusqu'en France entre dans le prix de revient. L'omettre
      // donnerait un coût calculé pour un autre pays.
      ship_to_country: "FR",
    }),
  };
  parametres["sign"] = await signRequest(
    chemin,
    parametres,
    c.env.ALIBABA_APP_SECRET,
  );

  /*
   * TOUTES LES API D'ALIBABA NE PARLENT PAS LA MÊME MÉTHODE.
   *
   * `/alibaba/order/list` répond en POST ; celle-ci a rendu
   * « UnsupportedHTTPMethod ». Le formulaire de l'explorateur propose bien
   * quatre méthodes, sans dire laquelle va avec quelle API — on essaie donc,
   * plutôt que de redéployer à chaque hypothèse.
   *
   * En GET, les paramètres passent par la chaîne de requête. La signature,
   * elle, se calcule de la même façon : sur les valeurs, avant encodage.
   */
  const base = `https://openapi-api.alibaba.com/rest${chemin}`;
  const tentatives: Array<{ methode: string; envoi: () => Promise<Response> }> =
    [
      {
        methode: "GET",
        envoi: () =>
          fetch(`${base}?${new URLSearchParams(parametres)}`, {
            method: "GET",
          }),
      },
      {
        methode: "POST",
        envoi: () =>
          fetch(base, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(parametres),
          }),
      },
      {
        methode: "PUT",
        envoi: () =>
          fetch(base, {
            method: "PUT",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(parametres),
          }),
      },
    ];

  let reponse!: Response;
  let texte = "";
  let methodeRetenue = "";
  for (const t of tentatives) {
    reponse = await t.envoi();
    texte = await reponse.text();
    methodeRetenue = t.methode;
    // On s'arrête dès que la méthode cesse d'être le problème.
    if (!texte.includes("UnsupportedHTTPMethod")) break;
  }

  // On rend le brut ET une lecture. Le brut sert à voir ce qu'Alibaba dit
  // vraiment ; la lecture, à vérifier qu'on le comprend bien.
  let lecture: unknown = null;
  try {
    const j = JSON.parse(texte) as {
      result?: {
        result_data?: {
          title?: string;
          description?: string;
          images?: string[];
          main_image?: string;
          category?: string;
          min_order_quantity?: number;
          currency?: string;
          detail_url?: string;
          supplier?: string;
          weight?: string;
          skus?: Array<{
            sku_id?: number;
            image?: string;
            cost_origin_price?: string | number;
            total_origin_cost_price?: string | number;
            shipping_fee?: string | number;
            ladder_price?: Array<{
              min_quantity?: number;
              max_quantity?: number;
              price?: number;
              currency?: string;
            }>;
            sku_attr_list?: Array<{
              attr_name_desc?: string;
              attr_value_desc?: string;
              attr_value_image?: string;
            }>;
          }>;
        };
        result_msg?: string;
        result_code?: string;
      };
    };
    const d = j.result?.result_data;
    if (d) {
      // La quantité minimale est la clé de lecture de tous les montants.
      const qmin = Number(d.min_order_quantity ?? 0);
      const arrondi = (n: number) =>
        Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
      lecture = {
        titre: d.title,
        fournisseur: d.supplier,
        categorie: d.category,
        quantiteMinimale: d.min_order_quantity,
        photos: (d.images ?? []).length,
        lien: d.detail_url,
        declinaisons: (d.skus ?? []).map((sku) => ({
          // Le nom lisible d'une déclinaison est la concaténation de ses
          // attributs — « Color: 40oz solid color tumbler 1.0 ».
          nom:
            (sku.sku_attr_list ?? [])
              .map((a) => a.attr_value_desc)
              .filter(Boolean)
              .join(" · ") || "sans déclinaison",
          axe: (sku.sku_attr_list ?? [])[0]?.attr_name_desc ?? null,
          photo: sku.image ?? (sku.sku_attr_list ?? [])[0]?.attr_value_image,
          /*
           * CES MONTANTS SONT DES TOTAUX DE COMMANDE, PAS DES PRIX UNITAIRES.
           *
           * Le piège se voit en croisant deux champs : `ladder_price` annonce
           * 2,56 € la pièce à partir de 500, et `cost_origin_price` vaut
           * 1277,47 € — soit 500 × 2,56. Ce sont donc les montants pour la
           * QUANTITÉ MINIMALE de commande.
           *
           * Les prendre pour des prix unitaires ferait afficher un coût de
           * revient quatre cents fois trop élevé, et une marge absurde. On
           * rend donc les deux lectures, chacune nommée pour ce qu'elle est.
           */
          commandeMinimale: {
            quantite: qmin,
            marchandise: sku.cost_origin_price,
            fret: sku.shipping_fee,
            total: sku.total_origin_cost_price,
          },
          parPiece:
            qmin > 0
              ? {
                  marchandise: arrondi(Number(sku.cost_origin_price) / qmin),
                  fret: arrondi(Number(sku.shipping_fee) / qmin),
                  debarque: arrondi(
                    Number(sku.total_origin_cost_price) / qmin,
                  ),
                }
              : null,
          paliers: sku.ladder_price,
        })),
      };
    }
  } catch {
    // Le brut suffira à comprendre.
  }

  return c.json({
    productId,
    methode: methodeRetenue,
    statutHttp: reponse.status,
    lecture,
    reponseBrute: texte.slice(0, 6000),
    tronquee: texte.length > 6000,
  });
});
