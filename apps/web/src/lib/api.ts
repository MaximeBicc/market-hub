/**
 * Client HTTP.
 *
 * Même origine que l'API : pas de CORS, pas de jeton à gérer côté client.
 * Le cookie de session est HttpOnly, donc invisible pour ce code — c'est voulu :
 * un script injecté ne peut pas le voler.
 *
 * Un 401 signifie session expirée : on recharge, ce qui renvoie sur la connexion.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });

  if (res.status === 401) {
    window.location.reload();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  // La clé `body` est omise plutôt que mise à undefined : sous
  // `exactOptionalPropertyTypes`, RequestInit refuse un body explicitement
  // undefined, et un POST sans corps doit vraiment ne pas en avoir.
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
};

/* ------------------------------ Types ------------------------------ */

export interface Overview {
  shops: Array<{ id: string; platform: string; name: string; status: string }>;
  today: { count: number; total: number };
  week: { count: number; total: number };
  lowStockCount: number;
  health: Array<{
    resource: string;
    shopId: string;
    lastOkAt: number | null;
    failureCount: number;
    lastError: string | null;
  }>;
  needsAttention: Array<{ id: string; name: string; status: string }>;
}

export interface OrderRow {
  id: string;
  externalId: string;
  status: string;
  amount: number;
  currency: string;
  buyer: string | null;
  placedAt: number;
  shopName: string;
  platform: string;
}

export interface ListingRow {
  id: string;
  externalId: string;
  sku: string | null;
  title: string;
  price: number;
  currency: string;
  quantity: number;
  status: string;
  imageUrl: string | null;
  shopId: string;
  shopName: string;
  platform: string;
}

export function money(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

export function when(ts: number): string {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(ts * 1000));
}
