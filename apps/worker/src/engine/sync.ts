import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import type { SyncTask } from "@hub/core";
import { reconcileStock, planReleves } from "@hub/engine";
import type { RemoteListing } from "@hub/engine";
import { recalculerStockProduit } from "../lib/stock-produit.js";
import { normaliserValeur } from "../lib/variantes.js";
import {
  estSupprime,
  leverMarque,
  marquerSupprime,
} from "../lib/suppression.js";
import {
  eventLog,
  listing,
  listingGroup,
  product,
  salesEvent,
  shop,
  syncJob,
  variant,
} from "../db/schema.js";
import type { Env } from "../env.js";
import { contentHash, randomId } from "../lib/crypto.js";
import { buildEngine } from "./module.js";
import { d1Repositories } from "./repositories.js";

/**
 * SYNCHRONISATION PÉRIODIQUE, via le moteur.
 *
 * Remplace l'ancienne couche de connecteurs. La différence n'est pas
 * cosmétique : une vente constatée ici passe par le point d'entrée canonique,
 * donc elle est dédupliquée et **propagée aux autres canaux**. L'ancienne
 * version se contentait d'écrire la commande en base.
 *
 * Deux ressources, deux traitements :
 *
 *   listings / inventory  → relit le catalogue. Le stock CENTRAL ne suit pas
 *                           aveuglément la plateforme : voir plus bas.
 *   orders                → relève les ventes et les fait entrer par
 *                           salesSync, qui décrémente et propage.
 */

/**
 * Normalise un libellé d'option pour en faire une clé stable.
 *
 * « Rose Pâle », « rose pale » et « ROSE PÂLE » doivent désigner la même
 * variante : sans pliage des accents et de la casse, un changement cosmétique
 * chez la plateforme créerait une variante fantôme, avec son propre stock.
 */

/**
 * Reconstitue les axes du produit à partir de ce que ses variantes portent.
 *
 * On n'écrit que si l'ensemble a CHANGÉ : ces axes servent à l'affichage et à
 * la publication, et les réécrire à chaque passage brûlerait le quota
 * d'écritures de D1 pour rien.
 */
async function majAxes(
  db: ReturnType<typeof drizzle>,
  productId: string,
  valeurs: Array<{ name: string; value: string }>,
  now: number,
): Promise<void> {
  const rows = await db
    .select({ options: product.options })
    .from(product)
    .where(eq(product.id, productId))
    .limit(1);

  const actuels = JSON.parse(rows[0]?.options ?? "[]") as Array<{
    name: string;
    values: string[];
  }>;
  const par = new Map(actuels.map((a) => [a.name, new Set(a.values)]));

  let change = false;
  for (const v of valeurs) {
    const ens = par.get(v.name);
    if (!ens) {
      par.set(v.name, new Set([v.value]));
      change = true;
    } else if (!ens.has(v.value)) {
      ens.add(v.value);
      change = true;
    }
  }
  if (!change) return;

  await db
    .update(product)
    .set({
      options: JSON.stringify(
        [...par].map(([name, values]) => ({ name, values: [...values] })),
      ),
      updatedAt: now,
    })
    .where(eq(product.id, productId));
}

/** Marge de tolérance avant de considérer une divergence comme réelle. */
const MAX_PAGES_PER_RUN = 4;

export async function runEngineSync(
  env: Env,
  task: SyncTask,
  counter: { used: number },
): Promise<void> {
  const db = drizzle(env.DB);
  const repos = d1Repositories(env.DB, env.MASTER_KEY);
  const mod = buildEngine(env, counter);

  const account = await repos.accounts.get(task.shopId);
  if (!account) throw new Error(`Compte inconnu : ${task.shopId}`);
  if (!account.enabled) return;

  const adapter = mod.registry.get(account.marketplace);
  // Copie mutable : un jeton renouvelé doit être visible des appels suivants
  // de cette même invocation. Voir la note dans l'orchestrateur.
  const credentials = { ...(await repos.credentials.get(task.shopId)) };

  const ctx = {
    account,
    credentials,
    // Le fetch régulé, et non le global : sans lui, la synchronisation
    // périodique appelait les plateformes sans passer par le seau à jetons.
    // C'est le chemin le plus fréquent de tout l'outil, donc précisément
    // celui qu'il ne fallait pas laisser hors régulation.
    http: mod.httpFor(account),
    saveCredentials: async (patch: Record<string, string>) => {
      Object.assign(credentials, patch);
      await repos.credentials.put(task.shopId, credentials);
    },
  };

  const now = Math.floor(Date.now() / 1000);
  let nextCursor: string | undefined;

  if (task.resource === "orders") {
    nextCursor = await syncOrders(env, mod, adapter, ctx, task, counter);
  } else {
    nextCursor = await syncCatalogue(env, mod, adapter, ctx, task);
  }

  // Page suivante : nouveau message, budget de sous-requêtes neuf.
  if (nextCursor && task.depth < 20) {
    await env.SYNC_QUEUE.send({ ...task, cursor: nextCursor, depth: task.depth + 1 });
    await db
      .update(syncJob)
      .set({ cursor: nextCursor, lastRunAt: now })
      .where(
        and(eq(syncJob.shopId, task.shopId), eq(syncJob.resource, task.resource)),
      );
    return;
  }

  await db
    .update(syncJob)
    .set({ cursor: null, lastOkAt: now, failureCount: 0, lastError: null })
    .where(
      and(eq(syncJob.shopId, task.shopId), eq(syncJob.resource, task.resource)),
    );
}

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

/**
 * Relit le catalogue de la plateforme.
 *
 * CE QUE FAIT CETTE FONCTION : mettre à jour le prix, le titre et le statut de
 * l'annonce locale, et rattacher les nouvelles annonces à un produit maître.
 *
 * CE QU'ELLE NE FAIT PAS : écraser le stock central avec la valeur de la
 * plateforme. La plateforme est un MIROIR du stock central, pas sa source.
 * Si une vente vient de partir sur eBay et n'a pas encore été écrite chez
 * Shopify, recopier la valeur Shopify annulerait la vente eBay. La divergence
 * est signalée dans le journal, et c'est la propagation qui la résorbe.
 *
 * Exception : une annonce inconnue jusqu'ici n'a pas de stock central. Sa
 * valeur distante l'initialise, comme à l'import.
 */
async function syncCatalogue(
  env: Env,
  mod: ReturnType<typeof buildEngine>,
  adapter: ReturnType<ReturnType<typeof buildEngine>["registry"]["get"]>,
  ctx: Parameters<NonNullable<typeof adapter.fetchListings>>[0],
  task: SyncTask,
): Promise<string | undefined> {
  if (!adapter.fetchListings) return undefined;

  const db = drizzle(env.DB);
  const repos = d1Repositories(env.DB, env.MASTER_KEY);
  const now = Math.floor(Date.now() / 1000);

  let cursor = task.cursor ?? undefined;
  let pages = 0;
  /** Écarts résorbés en recopiant la plateforme vers le stock central. */
  const adoptions: string[] = [];
  /** Les produits dont une variante a bougé, à résumer en fin de passage. */
  const touches = new Set<string>();
  /** Écarts à résorber dans l'autre sens : le central a bougé, pas la plateforme. */
  const aPousser: Array<{
    productId: string;
    variantId: string;
    stock: number;
    quoi: string;
  }> = [];

  while (pages < MAX_PAGES_PER_RUN) {
    /*
     * Le relevé d'inventaire ne regarde que les quantités : il n'a aucune
     * raison de payer les appels dédiés au prix et au statut. Chez eBay, ce
     * seul drapeau fait passer une page de seize requêtes à une.
     *
     * Le catalogue complet, lui, lit tout — une fois par jour.
     */
    const page = await adapter.fetchListings(ctx, cursor, {
      stockSeul: task.resource === "inventory",
    });
    pages++;

    const existing = await db
      .select({
        externalId: listing.externalId,
        contentHash: listing.contentHash,
        productId: listing.productId,
        variantId: listing.variantId,
        groupId: listing.groupId,
        quantity: listing.quantity,
        marketplaceData: listing.marketplaceData,
        // Relus pour être PRÉSERVÉS quand le relevé ne les a pas lus.
        priceAmount: listing.priceAmount,
        priceCurrency: listing.priceCurrency,
        status: listing.status,
        title: listing.title,
      })
      .from(listing)
      .where(eq(listing.shopId, task.shopId));
    const known = new Map(existing.map((r) => [r.externalId, r]));

    const writes = [];
    /*
     * Les annonces trouvées chez la plateforme que l'outil ne reconnaît pas.
     *
     * Elles sont recensées pour être montrées, jamais absorbées : voir la
     * règle du stock plus bas. Le journal en garde la trace même quand
     * personne ne regarde l'écran — c'est ainsi qu'on découvre qu'une
     * boutique s'est mise à publier de son côté.
     */
    const intruses: Array<{
      remoteId: string;
      titre: string;
      sku: string | null;
    }> = [];

    for (const item of page.items) {
      const prev = known.get(item.remoteId);

      /*
       * CE QU'ON N'A PAS LU, ON NE L'ÉCRIT PAS.
       *
       * En relevé de stock, le module ne rend que les quantités : prix,
       * statut et titre portent des valeurs de remplissage. Les écrire
       * remettrait TOUS LES PRIX À ZÉRO, silencieusement, à chaque passage.
       *
       * L'empreinte porte sur ce qu'on s'apprête à écrire, pas sur ce qu'on a
       * reçu. Sinon un relevé de stock ferait basculer l'empreinte à chaque
       * fois — les valeurs de remplissage différant des vraies — et
       * réécrirait la ligne entière à chaque passage, pour rien.
       */
      const garder = Boolean(item.stockSeul && prev);
      const prix = garder ? prev!.priceAmount : item.price.amount;
      const devise = garder ? prev!.priceCurrency : item.price.currency;
      const statut = garder
        ? (prev!.status as RemoteListing["status"])
        : item.status;
      const titre = garder ? prev!.title : item.title;

      const hash = await contentHash({
        p: prix,
        q: item.stock,
        s: statut,
        t: titre,
      });

      /*
       * ══ DU PLAT AU GROUPÉ ══
       *
       * Une plateforme n'envoie pas des produits, elle envoie des unités
       * vendables. Dix-sept coloris d'un support téléphone arrivent comme
       * dix-sept lignes — et vingt-six d'entre elles n'avaient aucun SKU,
       * parce que Shopify n'en impose pas. L'ancien code ne savait rapprocher
       * que par SKU : ces vingt-six lignes restaient donc sans produit maître,
       * et une vente sur l'une d'elles ne décrémentait RIEN.
       *
       * On remonte maintenant la chaîne dans l'autre sens :
       *   le groupe distant  →  le produit maître  →  la variante
       *
       * `groupRemoteId` est fourni par l'adaptateur. Une annonce sans parent
       * est son propre groupe : le cas dégénéré est le cas général, il n'y a
       * donc qu'un seul chemin de code.
       */
      const cleGroupe = item.groupRemoteId ?? item.remoteId;

      const groupeExistant = await db
        .select({
          id: listingGroup.id,
          productId: listingGroup.productId,
          marketplaceData: listingGroup.marketplaceData,
        })
        .from(listingGroup)
        .where(
          and(
            eq(listingGroup.shopId, task.shopId),
            eq(listingGroup.remoteGroupId, cleGroupe),
          ),
        )
        .limit(1);

      let groupId = groupeExistant[0]?.id ?? null;
      let productId = groupeExistant[0]?.productId ?? prev?.productId ?? null;

      /*
       * CE QUI A ÉTÉ SUPPRIMÉ DU STOCK NE DOIT PAS RENAÎTRE ICI.
       *
       * L'annonce, elle, survit à la suppression : elle est retirée de la
       * vente chez la plateforme mais conservée, parce que son ancienneté et
       * ses avis ne se rachètent pas. Le relevé continue donc de la voir.
       *
       * Sans cette marque, il n'y trouvait ni produit rattaché ni SKU connu et
       * en concluait qu'il découvrait un article : il fabriquait un produit
       * maître, et le produit supprimé réapparaissait dans le stock à la
       * minute suivante — avec un SKU « auto:… ». C'est le défaut qui rendait
       * la suppression inopérante.
       */
      const supprime =
        !productId &&
        (estSupprime(prev?.marketplaceData) ||
          estSupprime(groupeExistant[0]?.marketplaceData));

      // Un SKU connu rattache au produit existant : c'est la voie la plus sûre
      // quand elle est disponible, parce qu'elle survit à un changement de
      // structure chez la plateforme.
      if (!productId && !supprime && item.sku) {
        const p = await db
          .select({ id: product.id })
          .from(product)
          .where(eq(product.sku, item.sku))
          .limit(1);
        productId = p[0]?.id ?? null;
      }

      /*
       * ══ LE STOCK DE L'OUTIL FAIT FOI ══
       *
       * Une annonce qu'on ne reconnaît ni par son produit ni par son SKU n'a
       * pas été créée ici : elle a été saisie directement chez la plateforme.
       *
       * L'ABSORBER ÉTAIT LE PIRE DES DEUX MONDES, et c'est ce qu'on faisait —
       * un produit maître au SKU « auto:… », dont le stock entrait dans les
       * comptes. Or ce stock, personne ne l'a jamais compté ici. L'outil se
       * mettait donc à promettre sur les autres boutiques des pièces dont il
       * ignore tout, et à retirer des annonces sur la foi d'un total faux.
       * C'est aussi ce qui a fabriqué un « produit » nommé
       * « ALI-1601446602207-106700283643 », à zéro euro et sans photo : une
       * variante promue produit par ce chemin.
       *
       * L'annonce est donc SIGNALÉE, et n'entre pas dans le stock. Son
       * retrait chez la plateforme reste un geste explicite : le déclencher
       * ici, dans une tâche de fond, retirerait d'un coup tout ce qui existait
       * sur les boutiques avant l'arrivée de l'outil — y compris ce qui se
       * vend.
       */
      /*
       * SIGNALÉE UNE FOIS, PAS À CHAQUE PASSAGE.
       *
       * `prev` est l'annonce telle qu'on la connaissait déjà. Sans cette
       * condition, une intruse serait rejournalisée à chaque relevé — quatre-
       * vingt-seize fois par jour et par annonce — et le journal deviendrait
       * illisible au moment précis où il sert à quelque chose. On ne signale
       * donc que la PREMIÈRE rencontre.
       */
      if (!productId && !supprime && !prev) {
        intruses.push({
          remoteId: item.remoteId,
          titre: item.groupTitle ?? item.title,
          sku: item.sku ?? null,
        });
      }

      /*
       * ADOPTER UN GROUPE ORPHELIN.
       *
       * La migration a reconstitué les groupes depuis ce que Shopify avait
       * déjà écrit, mais elle a refusé d'inventer un produit maître là où il
       * n'y en avait pas — quatre groupes sur six sont donc nés sans.
       *
       * Sans cette mise à jour, le groupe resterait orphelin à vie : chaque
       * passage retrouverait `productId` à null, ne trouverait aucun SKU,
       * créerait un nouveau produit maître… et recommencerait deux minutes
       * plus tard. Six produits fantômes par quart d'heure.
       */
      if (groupId && productId && !groupeExistant[0]?.productId) {
        await db
          .update(listingGroup)
          .set({
            productId,
            // Un groupe de nouveau rattaché n'est plus un groupe supprimé.
            // Recréer le produit avec le même SKU suffit à le reprendre en
            // main : un geste humain défait ce qu'un geste humain avait fait.
            marketplaceData: leverMarque(groupeExistant[0]?.marketplaceData),
            syncedAt: now,
          })
          .where(eq(listingGroup.id, groupId));
      }

      if (!groupId) {
        groupId = randomId();
        await db
          .insert(listingGroup)
          .values({
            id: groupId,
            shopId: task.shopId,
            productId,
            remoteGroupId: cleGroupe,
            title: item.groupTitle ?? item.title,
            status: item.status,
            url: item.url ?? null,
            imageUrl: item.imageUrl ?? null,
            publishedAxes: JSON.stringify(
              (item.optionValues ?? []).map((o) => o.name),
            ),
            marketplaceData: "{}",
            syncedAt: now,
          })
          .onConflictDoUpdate({
            target: [listingGroup.shopId, listingGroup.remoteGroupId],
            set: { productId, syncedAt: now },
          });
      }

      /*
       * LA VARIANTE. Deux identités possibles, dans cet ordre :
       *
       *   1. le SKU, quand il existe — stable, porté par les lignes de commande
       *   2. la clé d'options — « couleur=violet », normalisée
       *
       * Sans la seconde, une variante sans SKU serait recréée à chaque passage
       * de synchronisation, et son stock repartirait de zéro toutes les deux
       * minutes.
       *
       * Rien de tout cela pour une annonce dont le produit a été supprimé du
       * stock : pas de produit maître, donc pas de variante où accrocher un
       * stock, et pas de stock à rapprocher. On relève l'annonce — elle existe
       * toujours chez la plateforme — et on s'arrête là.
       */
      let variantId: string | null = null;

      if (productId) {
        const optionKey = (item.optionValues ?? [])
          .map(
            (o) =>
              `${normaliserValeur(o.name)}=${normaliserValeur(o.value)}`,
          )
          .join("|");

        const varianteExistante = await db
          .select({ id: variant.id })
          .from(variant)
          .where(
            item.sku
              ? and(eq(variant.productId, productId), eq(variant.sku, item.sku))
              : and(
                  eq(variant.productId, productId),
                  eq(variant.optionKey, optionKey),
                ),
          )
          .limit(1);

        variantId = varianteExistante[0]?.id ?? null;
        touches.add(productId);

        if (!variantId) {
          variantId = randomId();
          await db
            .insert(variant)
            .values({
              id: variantId,
              productId,
              sku: item.sku,
              optionKey,
              optionValues: JSON.stringify(
                (item.optionValues ?? []).map((o) => o.value),
              ),
              priceAmount: prix,
              priceCurrency: devise,
              imageUrl: item.imageUrl ?? null,
              position: 0,
              status: "active",
              marketplaceData: "{}",
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [variant.productId, variant.optionKey],
              set: { sku: item.sku, priceAmount: prix, updatedAt: now },
            });

          // Variante inconnue : sa valeur distante initialise le stock central.
          await mod.inventoryService.ensure(variantId, item.stock);
        }

        // Les axes du produit, reconstitués depuis ce que les variantes portent.
        if ((item.optionValues ?? []).length > 0) {
          await majAxes(db, productId, item.optionValues ?? [], now);
        }
      }

      /*
       * RAPPROCHEMENT DU STOCK — le cœur de cette fonction.
       *
       * La question n'est pas « qui a raison » mais « QUI A BOUGÉ ». Le stock
       * central porte un compteur de version qu'on incrémente à chaque
       * modification ; l'annonce mémorise la version qu'elle avait vue la
       * dernière fois. Comparer les deux tranche sans ambiguïté :
       *
       *   version actuelle > version mémorisée
       *       → le central a bougé (une vente ailleurs, presque toujours) et
       *         la plateforme est en retard. On lui pousse la valeur.
       *
       *   version identique mais valeurs différentes
       *       → personne n'a touché au central, donc c'est la plateforme qui
       *         a changé — quelqu'un a modifié le stock directement chez elle.
       *         Cette valeur-là est la plus récente : on l'adopte.
       *
       * L'ancienne version se contentait de journaliser l'écart en attendant
       * qu'une vente le résorbe. Deux conséquences : un stock modifié à la
       * main chez la plateforme n'arrivait jamais jusqu'ici, et le contrôle
       * était placé APRÈS la sortie anticipée sur l'empreinte — donc dès que
       * l'annonce cessait de bouger, l'écart devenait invisible pour toujours.
       */
      let versionCentrale = 0;
      let rapprochement = false;

      // `productId` va toujours avec `variantId` — la variante appartient au
      // produit. Le nommer ici dit au compilateur ce que le flux garantit.
      if (productId && variantId) {
        const central = await repos.inventory.get(variantId);
        if (central) {
          versionCentrale = central.version;
          const prevData = JSON.parse(prev?.marketplaceData ?? "{}") as Record<
            string,
            unknown
          >;
          const vue = Number(prevData["centralVersion"] ?? 0);

          const decision = reconcileStock({
            centralOnHand: central.onHand,
            centralVersion: central.version,
            seenVersion: vue,
            remoteStock: item.stock,
          });

          if (decision.action === "push") {
            aPousser.push({
              productId,
              variantId,
              stock: decision.stock,
              quoi: `${item.sku ?? item.remoteId} → ${decision.stock}`,
            });
          } else if (decision.action === "adopt") {
            const apres = await mod.inventoryService.adopt(
              variantId,
              decision.stock,
            );
            versionCentrale = apres.version;
            rapprochement = true;
            adoptions.push(
              `${item.sku ?? item.remoteId} : ${central.onHand} → ${decision.stock} (${decision.reason})`,
            );
          }
        }
      }

      /*
       * Sortie anticipée — mais seulement si TOUT est déjà en place.
       *
       * Le rattachement à la variante et au groupe fait partie de « en
       * place ». Sans cette condition, une annonce dont le prix et le stock
       * n'ont pas bougé était sautée avant d'avoir reçu sa variante : le
       * modèle se remplissait, les annonces restaient orphelines, et une
       * vente continuait à ne rien décrémenter. Exactement le défaut que
       * cette refonte devait corriger.
       */
      /*
       * La marque de suppression est RECOPIÉE d'un relevé à l'autre.
       *
       * Ce champ est réécrit en entier à chaque passage : la laisser tomber
       * ici l'effacerait au premier relevé, et le produit renaîtrait au
       * second. Elle disparaît le jour où l'annonce retrouve un produit.
       */
      const donneesAnnonce = JSON.stringify({
        ...(item.marketplaceData ?? {}),
        // Sans cette trace, impossible de savoir lequel des deux côtés a bougé
        // au passage suivant.
        centralVersion: versionCentrale,
      });
      const donneesFinales = supprime
        ? marquerSupprime(donneesAnnonce, now)
        : donneesAnnonce;

      const rattachee = productId
        ? Boolean(prev?.variantId && prev?.groupId)
        : // Détachée volontairement : ne jamais la considérer « à rattacher »,
          // sinon sa ligne serait réécrite à chaque passage, pour rien.
          Boolean(prev?.groupId);
      if (prev?.contentHash === hash && !rapprochement && rattachee) continue;

      writes.push(
        db
          .insert(listing)
          .values({
            id: randomId(),
            shopId: task.shopId,
            productId,
            variantId,
            groupId,
            optionValues: JSON.stringify(item.optionValues ?? []),
            externalId: item.remoteId,
            sku: item.sku,
            title: titre,
            priceAmount: prix,
            priceCurrency: devise,
            quantity: item.stock,
            status: statut,
            url: item.url ?? null,
            imageUrl: item.imageUrl ?? null,
            marketplaceData: donneesFinales,
            contentHash: hash,
            syncedAt: now,
          })
          .onConflictDoUpdate({
            target: [listing.shopId, listing.externalId],
            set: {
              productId,
              variantId,
              groupId,
              optionValues: JSON.stringify(item.optionValues ?? []),
              sku: item.sku,
              // Les mêmes valeurs qu'à l'insertion : c'est la branche qui
              // s'exécute en pratique, l'annonce existant presque toujours.
              // L'oublier ici aurait remis les prix à zéro à chaque relevé,
              // en laissant croire le contraire à la lecture de l'insertion.
              title: titre,
              priceAmount: prix,
              priceCurrency: devise,
              quantity: item.stock,
              status: statut,
              /*
               * L'adresse publique se met à jour mais ne s'efface pas : les
               * plateformes ne la rendent pas toutes au relevé, et la
               * remettre à NULL ferait disparaître le lien d'une annonce
               * pourtant en ligne.
               */
              url: sql`coalesce(${item.url ?? null}, ${listing.url})`,
              imageUrl: item.imageUrl ?? null,
              marketplaceData: donneesFinales,
              contentHash: hash,
              syncedAt: now,
            },
          }),
      );
    }

    if (writes.length) await db.batch(writes as never);

    /*
     * Les intruses sont CONSIGNÉES, jamais absorbées.
     *
     * Sans cette trace, une boutique qui se met à publier de son côté ne se
     * remarque pas : ses annonces n'entrent plus dans le stock — c'est voulu —
     * mais rien ne dit qu'elles existent. On les découvrirait à la première
     * vente d'un article que l'outil ne connaît pas.
     */
    if (intruses.length > 0) {
      await db.insert(eventLog).values({
        id: randomId(),
        at: now,
        level: "warn",
        scope: `intruses:${ctx.account.marketplace}`,
        shopId: task.shopId,
        message: `${intruses.length} annonce(s) trouvée(s) chez ${ctx.account.marketplace} sans équivalent dans l'outil. Elles n'entrent pas dans le stock : leur stock n'a jamais été compté ici, et l'ajouter fausserait ce qui est promis aux autres boutiques.`,
        data: JSON.stringify(intruses.slice(0, 20)),
      });
    }

    cursor = page.cursor;
    if (!cursor) break;
  }

  /*
   * Le résumé de chaque produit touché.
   *
   * Sans cette passe, `product.stock` reste sur la valeur écrite à la
   * création — zéro pour un produit né d'un groupe — et tous les écrans qui
   * l'affichent mentent, alors que le stock par variante est juste.
   */
  for (const productId of touches) {
    await recalculerStockProduit(db, productId);
  }

  if (adoptions.length > 0) {
    await db.insert(eventLog).values({
      id: randomId(),
      at: now,
      level: "info",
      scope: `stock:${ctx.account.marketplace}`,
      shopId: task.shopId,
      message: `Stock central aligné sur ${adoptions.length} article(s) modifié(s) chez la plateforme`,
      data: JSON.stringify(adoptions.slice(0, 20)),
    });
  }

  /*
   * Pousser le stock central vers la plateforme en retard.
   *
   * Plafonné, et le plafond est JOURNALISÉ : une troncature silencieuse se
   * lirait comme « tout est aligné » alors qu'il reste des écarts. Le reste
   * part au passage suivant, quinze minutes plus tard.
   */
  const PLAFOND_POUSSEES = 10;
  if (aPousser.length > 0) {
    const lot = aPousser.slice(0, PLAFOND_POUSSEES);
    const echecs: string[] = [];

    for (const x of lot) {
      const r = await mod.orchestrator.setStock({
        productId: x.productId,
        // L'unité voyage avec la valeur. Sans elle, l'adaptateur refuse une
        // annonce déclinée plutôt que d'écrire sur un coloris au hasard — et
        // le rapprochement échouerait sur tout produit à plusieurs coloris,
        // c'est-à-dire la moitié du catalogue.
        variantId: x.variantId,
        accountIds: [task.shopId],
        stock: x.stock,
        idempotencyKey: `rapprochement:${task.shopId}:${x.productId}:${x.stock}`,
      });
      if (!r.anySuccess) {
        echecs.push(`${x.quoi} — ${r.results[0]?.message ?? "échec"}`);
      }
    }

    await db.insert(eventLog).values({
      id: randomId(),
      at: now,
      level: echecs.length > 0 ? "warn" : "info",
      scope: `stock:${ctx.account.marketplace}`,
      shopId: task.shopId,
      message:
        `${lot.length - echecs.length}/${lot.length} stock(s) poussés vers ${ctx.account.marketplace}` +
        (aPousser.length > lot.length
          ? ` — ${aPousser.length - lot.length} reporté(s) au passage suivant`
          : ""),
      data: JSON.stringify(
        echecs.length > 0 ? echecs.slice(0, 20) : lot.map((x) => x.quoi).slice(0, 20),
      ),
    });
  }

  return cursor;
}

/* ------------------------------------------------------------------ */
/* Ventes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Relève les ventes et les fait entrer par le point d'entrée canonique.
 *
 * C'est ici que la propagation se déclenche : `salesSync.ingest` décrémente le
 * stock central puis écrit la nouvelle valeur sur les AUTRES comptes. Les
 * événements déjà connus — dont ceux enregistrés à l'import — sont ignorés.
 */
async function syncOrders(
  env: Env,
  mod: ReturnType<typeof buildEngine>,
  adapter: ReturnType<ReturnType<typeof buildEngine>["registry"]["get"]>,
  ctx: Parameters<NonNullable<typeof adapter.pollOrderEvents>>[0],
  task: SyncTask,
  counter: { used: number },
): Promise<string | undefined> {
  if (!adapter.pollOrderEvents) return undefined;

  const db = drizzle(env.DB);
  const now = Math.floor(Date.now() / 1000);
  let cursor = task.cursor ?? undefined;
  let pages = 0;
  let nouvelles = 0;
  let orphelines = 0;

  while (pages < MAX_PAGES_PER_RUN) {
    const page = await adapter.pollOrderEvents(ctx, cursor);
    pages++;

    for (const event of page.events) {
      const r = await mod.salesSync.ingest(event);
      if (!r.duplicate) nouvelles++;
      orphelines += r.unmatched;

      // Le budget de sous-requêtes est partagé : la propagation vers d'autres
      // comptes en consomme. On rend la main avant d'être coupé.
      if (counter.used >= 34) {
        return cursor ?? page.cursor;
      }
    }

    cursor = page.cursor;
    if (!cursor) break;
  }

  if (nouvelles > 0 || orphelines > 0) {
    await db.insert(eventLog).values({
      id: randomId(),
      at: now,
      level: orphelines > 0 ? "warn" : "info",
      scope: `ventes:${ctx.account.marketplace}`,
      shopId: task.shopId,
      message:
        `${nouvelles} vente(s) traitée(s)` +
        (orphelines > 0
          ? `, ${orphelines} ligne(s) sans produit connu — SKU manquant ou article non importé`
          : ""),
      data: null,
    });
  }

  return cursor;
}

/* ------------------------------------------------------------------ */
/* Programmation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Crée les tâches périodiques d'un compte.
 *
 * Les cadences ne sont pas arbitraires : une plateforme qui pousse ses ventes
 * par webhook n'a pas besoin d'être relevée souvent, le relevé n'étant qu'un
 * filet si un webhook se perd. Une plateforme sans webhook n'a que le relevé.
 */
/**
 * REMET LES CADENCES D'APLOMB, SANS RIEN CASSER D'AUTRE.
 *
 * La cadence d'une boutique n'est recalculée qu'aux moments où quelqu'un
 * agit : connexion, activation du temps réel. Entre deux, elle peut rester
 * fausse indéfiniment — et c'est arrivé : eBay avait ses deux abonnements
 * actifs et relevait toujours toutes les deux minutes, soit 1 440 tâches par
 * jour au lieu de 192, sans qu'aucune erreur ne le signale. Une cadence
 * fausse ne casse rien de visible ; elle brûle le quota en silence.
 *
 * Ce passage horaire ne parle à AUCUNE plateforme : il relit le plan et
 * n'écrit que si la valeur stockée diffère. En régime établi il ne fait rien.
 *
 * Il n'écrit QUE l'intervalle et l'activation. Ni `failureCount`, ni
 * `lastError`, ni `nextRunAt` : ce sont les organes du recul progressif après
 * échec, et les remettre à zéro chaque heure ferait réessayer sans fin une
 * tâche qui échoue — le contraire du but.
 */
export async function reconcilierCadences(env: Env): Promise<{
  examinees: number;
  corrigees: Array<{ boutique: string; ressource: string; de: number; a: number }>;
}> {
  const db = drizzle(env.DB);
  const mod = buildEngine(env);
  const repos = d1Repositories(env.DB, env.MASTER_KEY);

  const boutiques = await db
    .select({ id: shop.id, nom: shop.displayName })
    .from(shop);

  const corrigees: Array<{
    boutique: string;
    ressource: string;
    de: number;
    a: number;
  }> = [];

  for (const b of boutiques) {
    const account = await repos.accounts.get(b.id);
    if (!account) continue;

    const credentials = await repos.credentials.get(b.id);
    let caps;
    try {
      caps = await mod.registry
        .get(account.marketplace)
        .capabilities({ account, ...(credentials ? { credentials } : {}) });
    } catch {
      // Une plateforme inconnue ne doit pas interrompre les autres.
      continue;
    }

    const plan = planReleves(caps, caps.pousseActive);
    const existants = await db
      .select({
        resource: syncJob.resource,
        intervalSec: syncJob.intervalSec,
        enabled: syncJob.enabled,
      })
      .from(syncJob)
      .where(eq(syncJob.shopId, b.id));

    for (const p of plan) {
      const actuel = existants.find((e) => e.resource === p.resource);
      if (!actuel) continue; // Rien à corriger : c'est `ensureSyncJobs` qui crée.
      const voulu = p.enabled ? 1 : 0;
      if (actuel.intervalSec === p.intervalSec && actuel.enabled === voulu) {
        continue;
      }
      await db
        .update(syncJob)
        .set({ intervalSec: p.intervalSec, enabled: voulu })
        .where(
          and(eq(syncJob.shopId, b.id), eq(syncJob.resource, p.resource)),
        );
      corrigees.push({
        boutique: b.nom,
        ressource: p.resource,
        de: actuel.intervalSec,
        a: p.intervalSec,
      });
    }
  }

  return { examinees: boutiques.length, corrigees };
}

export async function ensureSyncJobs(
  env: Env,
  accountId: string,
): Promise<void> {
  const db = drizzle(env.DB);
  const mod = buildEngine(env);
  const repos = d1Repositories(env.DB, env.MASTER_KEY);

  const account = await repos.accounts.get(accountId);
  if (!account) return;

  /*
   * LES IDENTIFIANTS SONT INDISPENSABLES ICI.
   *
   * Les appeler sans eux paraissait anodin — une capacité, c'est une
   * propriété de plateforme. Sauf que la question « cette boutique pousse-t-
   * elle ses ventes ? » ne se répond que sur le COMPTE, et le module lit son
   * drapeau dans les identifiants. Sans eux il répond « non » quoi qu'il
   * arrive, et eBay est resté relevé toutes les deux minutes malgré ses deux
   * abonnements actifs.
   */
  const credentials = await repos.credentials.get(accountId);
  const caps = await mod.registry
    .get(account.marketplace)
    .capabilities({ account, ...(credentials ? { credentials } : {}) });

  /*
   * « Pousse » ne veut pas dire « saurait pousser » mais « pousse
   * effectivement ». Shopify SAIT envoyer des webhooks ; encore faut-il lui
   * avoir demandé. Relâcher le relevé sur la seule capacité déclarée
   * ralentirait une boutique dont les abonnements n'ont jamais été créés —
   * exactement l'inverse du but.
   *
   * C'est le MODULE qui répond, plus le noyau : le drapeau ne porte pas le
   * même nom d'une plateforme à l'autre — `webhooksActifs` chez Shopify,
   * `notificationsActives` chez eBay, un secret de signature chez Etsy — et
   * le noyau n'en connaissait qu'un seul. Les deux autres ne relâchaient
   * donc jamais leur cadence.
   */
  const abonne = caps.pousseActive;
  const now = Math.floor(Date.now() / 1000);

  const plan = planReleves(caps, abonne);

  for (const p of plan) {
    await db
      .insert(syncJob)
      .values({
        id: randomId(),
        shopId: accountId,
        resource: p.resource,
        intervalSec: p.intervalSec,
        nextRunAt: now,
        enabled: p.enabled ? 1 : 0,
        failureCount: 0,
      })
      .onConflictDoUpdate({
        target: [syncJob.shopId, syncJob.resource],
        set: {
          intervalSec: p.intervalSec,
          enabled: p.enabled ? 1 : 0,
          failureCount: 0,
          lastError: null,
          nextRunAt: sql`min(${syncJob.nextRunAt}, ${now})`,
        },
      });
  }
}
