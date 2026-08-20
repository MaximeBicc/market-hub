import { drizzle } from "drizzle-orm/d1";
import { and, eq, or, isNull, sql } from "drizzle-orm";
import type { UnifiedListing, UnifiedOrder } from "@hub/core";
import { formatMoney } from "@hub/core";
import { alertRule } from "../db/schema.js";
import type { Env } from "../env.js";
import { sendPushToUser } from "./push.js";

/**
 * Moteur de règles d'alerte.
 *
 * Évalué APRÈS le diff de synchronisation, donc uniquement sur les objets qui
 * ont réellement changé. Un produit dont le stock est à 2 depuis trois semaines
 * ne déclenche pas une notification toutes les quinze minutes : il n'apparaît
 * dans `changed` que le jour où il bouge.
 *
 * Deuxième garde-fou : le `cooldownSec` par règle, qui évite le tir en rafale
 * quand une synchronisation complète remonte trente annonces d'un coup.
 */

interface Changes {
  orders?: UnifiedOrder[];
  listings?: UnifiedListing[];
}

export async function evaluateAlerts(
  env: Env,
  shopId: string,
  changes: Changes,
): Promise<void> {
  const db = drizzle(env.DB);
  const now = Math.floor(Date.now() / 1000);

  const rules = await db
    .select()
    .from(alertRule)
    .where(
      and(
        eq(alertRule.enabled, 1),
        or(isNull(alertRule.shopId), eq(alertRule.shopId, shopId)),
      ),
    );

  for (const rule of rules) {
    if (rule.lastFiredAt && now - rule.lastFiredAt < rule.cooldownSec) continue;

    const params = JSON.parse(rule.params) as Record<string, number>;
    const message = match(rule.kind, params, changes);
    if (!message) continue;

    await sendPushToUser(env, { ...message, tag: rule.kind });
    await db
      .update(alertRule)
      .set({ lastFiredAt: now })
      .where(eq(alertRule.id, rule.id));
  }
}

function match(
  kind: string,
  params: Record<string, number>,
  changes: Changes,
): { title: string; body: string; url: string } | null {
  switch (kind) {
    case "new_order": {
      const fresh = (changes.orders ?? []).filter(
        (o) => o.status === "paid" || o.status === "pending",
      );
      if (fresh.length === 0) return null;
      const total = fresh.reduce((sum, o) => sum + o.total.amount, 0);
      return {
        title: fresh.length === 1 ? "Nouvelle commande" : `${fresh.length} nouvelles commandes`,
        body: formatMoney({
          amount: total,
          currency: fresh[0]?.total.currency ?? "EUR",
        }),
        url: "/orders",
      };
    }

    case "big_order": {
      const threshold = params["minAmount"] ?? 20_000; // centimes
      const big = (changes.orders ?? []).find((o) => o.total.amount >= threshold);
      if (!big) return null;
      return {
        title: "Grosse commande",
        body: `${formatMoney(big.total)} — ${big.buyerName ?? "acheteur inconnu"}`,
        url: "/orders",
      };
    }

    case "low_stock": {
      const threshold = params["quantity"] ?? 3;
      const low = (changes.listings ?? []).filter(
        (l) => l.status === "active" && l.quantity <= threshold && l.quantity > 0,
      );
      if (low.length === 0) return null;
      return {
        title: "Stock bas",
        body: low
          .slice(0, 3)
          .map((l) => `${l.title} (${l.quantity})`)
          .join(" · "),
        url: "/inventory",
      };
    }

    case "sold_out": {
      const out = (changes.listings ?? []).filter((l) => l.status === "sold_out");
      if (out.length === 0) return null;
      return {
        title: "Rupture de stock",
        body: out.slice(0, 3).map((l) => l.title).join(" · "),
        url: "/inventory",
      };
    }

    default:
      return null;
  }
}

/** Règles créées à la première connexion, pour que l'app soit utile tout de suite. */
export const DEFAULT_RULES = [
  { kind: "new_order", name: "Nouvelle commande", params: {}, cooldownSec: 60 },
  {
    kind: "big_order",
    name: "Commande > 200 €",
    params: { minAmount: 20_000 },
    cooldownSec: 300,
  },
  {
    kind: "low_stock",
    name: "Stock ≤ 3",
    params: { quantity: 3 },
    cooldownSec: 3600,
  },
  { kind: "sold_out", name: "Rupture", params: {}, cooldownSec: 1800 },
] as const;
