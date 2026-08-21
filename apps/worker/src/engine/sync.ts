import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import type { SyncTask } from "@hub/core";
import { reconcileStock } from "@hub/engine";
import { eventLog, listing, product, salesEvent, syncJob } from "../db/schema.js";
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
  const credentials = await repos.credentials.get(task.shopId);

  const ctx = {
    account,
    credentials,
    // Le fetch régulé, et non le global : sans lui, la synchronisation
    // périodique appelait les plateformes sans passer par le seau à jetons.
    // C'est le chemin le plus fréquent de tout l'outil, donc précisément
    // celui qu'il ne fallait pas laisser hors régulation.
    http: mod.httpFor(account),
    saveCredentials: async (patch: Record<string, string>) => {
      await repos.credentials.put(task.shopId, { ...credentials, ...patch });
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
  /** Écarts à résorber dans l'autre sens : le central a bougé, pas la plateforme. */
  const aPousser: Array<{ productId: string; stock: number; quoi: string }> = [];

  while (pages < MAX_PAGES_PER_RUN) {
    const page = await adapter.fetchListings(ctx, cursor);
    pages++;

    const existing = await db
      .select({
        externalId: listing.externalId,
        contentHash: listing.contentHash,
        productId: listing.productId,
        quantity: listing.quantity,
        marketplaceData: listing.marketplaceData,
      })
      .from(listing)
      .where(eq(listing.shopId, task.shopId));
    const known = new Map(existing.map((r) => [r.externalId, r]));

    const writes = [];

    for (const item of page.items) {
      const hash = await contentHash({
        p: item.price.amount,
        q: item.stock,
        s: item.status,
        t: item.title,
      });
      const prev = known.get(item.remoteId);

      let productId = prev?.productId ?? null;
      if (!productId && item.sku) {
        const p = await db
          .select({ id: product.id })
          .from(product)
          .where(eq(product.sku, item.sku))
          .limit(1);
        productId = p[0]?.id ?? null;

        if (!productId) {
          productId = randomId();
          await db.insert(product).values({
            id: productId,
            sku: item.sku,
            title: item.title,
            description: null,
            priceAmount: item.price.amount,
            priceCurrency: item.price.currency,
            stock: item.stock,
            images: JSON.stringify(item.imageUrl ? [item.imageUrl] : []),
            tags: "[]",
            marketplaceData: "{}",
            createdAt: now,
            updatedAt: now,
          });
          // Produit inconnu : sa valeur distante initialise le stock central.
          await mod.inventoryService.ensure(productId, item.stock);
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

      if (productId) {
        const central = await repos.inventory.get(productId);
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
              stock: decision.stock,
              quoi: `${item.sku ?? item.remoteId} → ${decision.stock}`,
            });
          } else if (decision.action === "adopt") {
            const apres = await mod.inventoryService.adopt(
              productId,
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

      // Sortie anticipée, maintenant qu'elle ne peut plus masquer un écart :
      // ni l'annonce ni le stock central n'ont bougé, il n'y a rien à écrire.
      // C'est ce qui garde la consommation sous les 100 000 écritures/jour de D1.
      if (prev?.contentHash === hash && !rapprochement) continue;

      writes.push(
        db
          .insert(listing)
          .values({
            id: randomId(),
            shopId: task.shopId,
            productId,
            externalId: item.remoteId,
            sku: item.sku,
            title: item.title,
            priceAmount: item.price.amount,
            priceCurrency: item.price.currency,
            quantity: item.stock,
            status: item.status,
            url: item.url ?? null,
            imageUrl: item.imageUrl ?? null,
            marketplaceData: JSON.stringify({
              ...(item.marketplaceData ?? {}),
              // Sans cette trace, impossible de savoir lequel des deux côtés
              // a bougé au passage suivant.
              centralVersion: versionCentrale,
            }),
            contentHash: hash,
            syncedAt: now,
          })
          .onConflictDoUpdate({
            target: [listing.shopId, listing.externalId],
            set: {
              productId,
              sku: item.sku,
              title: item.title,
              priceAmount: item.price.amount,
              priceCurrency: item.price.currency,
              quantity: item.stock,
              status: item.status,
              imageUrl: item.imageUrl ?? null,
              marketplaceData: JSON.stringify({
                ...(item.marketplaceData ?? {}),
                centralVersion: versionCentrale,
              }),
              contentHash: hash,
              syncedAt: now,
            },
          }),
      );
    }

    if (writes.length) await db.batch(writes as never);

    cursor = page.cursor;
    if (!cursor) break;
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
export async function ensureSyncJobs(
  env: Env,
  accountId: string,
): Promise<void> {
  const db = drizzle(env.DB);
  const mod = buildEngine(env);
  const repos = d1Repositories(env.DB, env.MASTER_KEY);

  const account = await repos.accounts.get(accountId);
  if (!account) return;

  const caps = await mod.registry.get(account.marketplace).capabilities({ account });

  /*
   * « Pousse » ne veut pas dire « saurait pousser » mais « pousse
   * effectivement ». Shopify SAIT envoyer des webhooks ; encore faut-il lui
   * avoir demandé. Relâcher le relevé sur la seule capacité déclarée
   * ralentirait une boutique dont les abonnements n'ont jamais été créés —
   * exactement l'inverse du but.
   */
  const abonne =
    (await repos.credentials.get(accountId))?.["webhooksActifs"] === "1";
  const pousse =
    abonne && (caps.inboundSales === "webhook" || caps.inboundSales === "both");
  const now = Math.floor(Date.now() / 1000);

  const plan: Array<{ resource: string; intervalSec: number; enabled: boolean }> = [
    /*
     * CADENCE DU RELEVÉ.
     *
     * Le cron passe désormais chaque minute : c'est le plancher que
     * Cloudflare permet, et donc la latence minimale d'un relevé.
     *
     * 120 secondes plutôt que 60 quand rien n'est poussé : Etsy plafonne à
     * 10 000 requêtes par jour et lit son catalogue état par état — quatre
     * appels par passage. À la minute, le seul relevé mangerait les trois
     * quarts du quota et ne laisserait plus de marge aux actions manuelles.
     * À deux minutes, on reste sous la moitié.
     *
     * Quand la plateforme POUSSE, le relevé n'est plus qu'un filet : un
     * webhook perdu ou un abonnement désactivé ne doit pas faire disparaître
     * une vente, mais il n'a plus à courir.
     */
    { resource: "orders", intervalSec: pousse ? 900 : 120, enabled: caps.ordersRead },
    {
      resource: "inventory",
      intervalSec: pousse ? 900 : 120,
      enabled: caps.stockRead,
    },
    { resource: "listings", intervalSec: 86400, enabled: caps.stockRead },
  ];

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
