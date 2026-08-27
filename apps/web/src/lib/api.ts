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
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "PATCH",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "PUT",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
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
    /** Rythme prévu de cette tâche. Un retard ne se juge que contre lui. */
    intervalSec: number;
    /** Date de la prochaine tentative, repli exponentiel déjà appliqué. */
    nextRunAt: number;
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
  shippingCarrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  shippingLabelUrl?: string | null;
  shippingLabelType?: "scraped" | "uploaded" | "generated" | string | null;
  placedAt: number;
  shippedAt?: number | null;
  shopId: string;
  shopName: string;
  platform: string;
}

export interface OrderLineItem {
  id: string;
  sku: string | null;
  listingExternalId: string | null;
  title: string;
  quantity: number;
  unitPriceAmount: number;
  unitPriceCurrency: string;
  imageUrl: string | null;
  currentStock: number | null;
  location?: string | null;
  weightGrams?: number | null;
  defaultConsumableId?: string | null;
  color?: string | null;
  material?: string | null;
}

export interface OrderDetailResponse {
  order: OrderRow;
  lines: OrderLineItem[];
  consumablesUsed: Array<{
    id: string;
    consumableId: string;
    name: string;
    category: string;
    quantity: number;
    usedAt: number;
  }>;
}

export interface ConsumableItem {
  id: string;
  name: string;
  category: "envelope" | "box" | "card" | "label" | "protection" | "other" | string;
  stock: number;
  minAlert: number;
  unitCost?: number | null;
  imageUrl?: string | null;
}

export interface FulfillOrderPayload {
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  consumables: Array<{ id: string; quantity: number }>;
  giftProductId?: string;
  decrementProductStock?: boolean;
  notifyBuyer?: boolean;
}

export interface FulfillOrderResponse {
  ok: boolean;
  orderId: string;
  status: string;
  shippedAt: number;
  consumables: Array<{ id: string; name: string; quantity: number; remaining: number }>;
  products: Array<{ sku?: string; title: string; quantity: number; remainingStock: number | null }>;
  gift?: { id: string; title: string; sku?: string; remainingStock: number } | null;
}

export interface ProductItem {
  id: string;
  sku: string;
  title: string;
  description?: string | null;
  costPrice?: number | null; // centimes
  priceAmount: number; // centimes
  priceCurrency: string;
  stock: number;
  /** Nombre de déclinaisons actives — 1 pour un produit sans coloris. */
  variantCount?: number;
  minAlert: number;
  location?: string | null;
  weightGrams?: number | null;
  defaultConsumableId?: string | null;
  color?: string | null;
  material?: string | null;
  images?: string[] | null;
  tags?: string[] | null;
  listings?: ListingRow[];
  createdAt: number;
  updatedAt: number;
}

export interface InventoryResponse {
  products: ProductItem[];
  consumables: ConsumableItem[];
  listings: ListingRow[];
  multiChannel: Array<{ sku: string; listings: ListingRow[] }>;
  stats: {
    totalProducts: number;
    totalStockUnits: number;
    totalStockValue: number;
    lowStockProductsCount: number;
    lowStockConsumablesCount: number;
  };
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
