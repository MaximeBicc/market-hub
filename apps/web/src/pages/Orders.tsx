import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, when, type OrderRow } from "../lib/api.js";
import { Empty } from "../components/Empty.js";
import { Icon } from "../components/Icon.js";
import { FulfillmentModal } from "../components/FulfillmentModal.js";
import { PalmLoader } from "../components/PalmLoader.js";

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "en attente", cls: "pill--warn" },
  paid: { label: "à préparer", cls: "pill--ok" },
  shipped: { label: "expédiée", cls: "pill--info" },
  delivered: { label: "livrée", cls: "pill--mute" },
  cancelled: { label: "annulée", cls: "pill--stop" },
  refunded: { label: "remboursée", cls: "pill--stop" },
};

export function Orders() {
  const queryClient = useQueryClient();
  const [shop, setShop] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "to_fulfill" | "shipped" | "delivered">("all");
  const [search, setSearch] = useState("");
  const [activeFulfillmentOrderId, setActiveFulfillmentOrderId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["orders"],
    queryFn: () => api.get<{ orders: OrderRow[] }>("/orders"),
  });

  const { data: overview } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<import("../lib/api.js").Overview>("/overview"),
  });

  // Créer une commande de démonstration pour tester immédiatement
  const createSampleMutation = useMutation({
    mutationFn: () => api.post<{ ok: boolean; orderId: string }>("/orders/sample"),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
      if (res.orderId) {
        setActiveFulfillmentOrderId(res.orderId);
      }
    },
  });

  if (isLoading || !data) return <PalmLoader label="Chargement des commandes…" />;

  const shops = overview?.shops ?? [];
  const allOrders = data.orders;

  // Filtrage combiné (Boutique + Statut + Recherche)
  const filtered = allOrders.filter((o) => {
    // Filtre boutique
    if (shop !== "all" && o.shopId !== shop) return false;

    // Filtre statut
    if (statusFilter === "to_fulfill" && o.status !== "paid" && o.status !== "pending") return false;
    if (statusFilter === "shipped" && o.status !== "shipped") return false;
    if (statusFilter === "delivered" && o.status !== "delivered") return false;

    // Filtre recherche textuelle
    if (search.trim()) {
      const q = search.toLowerCase();
      const matchBuyer = o.buyer?.toLowerCase().includes(q);
      const matchExtId = o.externalId.toLowerCase().includes(q);
      const matchShop = o.shopName.toLowerCase().includes(q);
      const matchCarrier = o.shippingCarrier?.toLowerCase().includes(q);
      const matchTracking = o.trackingNumber?.toLowerCase().includes(q);
      if (!matchBuyer && !matchExtId && !matchShop && !matchCarrier && !matchTracking) return false;
    }

    return true;
  });

  const toFulfillCount = allOrders.filter((o) => o.status === "paid" || o.status === "pending").length;
  const totalAmount = filtered.reduce((s, o) => s + o.amount, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Commandes & Préparation</h1>
          <p>
            {filtered.length === 0
              ? "Aucune commande correspondante"
              : `${filtered.length} commande${filtered.length > 1 ? "s" : ""} · ${money(totalAmount)}`}
            {toFulfillCount > 0 && (
              <span className="pill pill--warn" style={{ marginLeft: 10 }}>
                {toFulfillCount} à préparer
              </span>
            )}
          </p>
        </div>

        <div className="page-head__actions">
          <button
            type="button"
            className="btn btn--small"
            onClick={() => createSampleMutation.mutate()}
            disabled={createSampleMutation.isPending}
            title="Créer une commande de test pour essayer le processus de préparation"
          >
            <Icon name="plus" /> Commande de test
          </button>
        </div>
      </div>

      {allOrders.length === 0 ? (
        <Empty
          icon="orders"
          title="Aucune commande pour l'instant"
          action={
            <div style={{ display: "flex", gap: 10 }}>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => createSampleMutation.mutate()}
              >
                <Icon name="sparkle" /> Créer une commande de test
              </button>
              {shops.length === 0 && (
                <a className="btn" href="/shops">
                  Connecter une boutique
                </a>
              )}
            </div>
          }
        >
          {shops.length === 0
            ? "Les commandes apparaîtront ici dès qu'une boutique sera reliée. Vous pouvez également tester le processus avec une commande démo."
            : "Vos boutiques sont connectées. Cliquez sur « Commande de test » pour essayer le flux de préparation en 5 étapes dès maintenant."}
        </Empty>
      ) : (
        <>
          {/* Barre d'outils et de filtres */}
          <div className="orders-toolbar">
            <div className="filters">
              <button
                className="chip"
                aria-pressed={statusFilter === "all"}
                onClick={() => setStatusFilter("all")}
              >
                Toutes ({allOrders.length})
              </button>
              <button
                className="chip"
                aria-pressed={statusFilter === "to_fulfill"}
                onClick={() => setStatusFilter("to_fulfill")}
              >
                À préparer ({toFulfillCount})
              </button>
              <button
                className="chip"
                aria-pressed={statusFilter === "shipped"}
                onClick={() => setStatusFilter("shipped")}
              >
                Expédiées ({allOrders.filter((o) => o.status === "shipped").length})
              </button>
              <button
                className="chip"
                aria-pressed={statusFilter === "delivered"}
                onClick={() => setStatusFilter("delivered")}
              >
                Livrées ({allOrders.filter((o) => o.status === "delivered").length})
              </button>
            </div>

            {shops.length > 1 && (
              <div className="filters">
                <button
                  className="chip"
                  aria-pressed={shop === "all"}
                  onClick={() => setShop("all")}
                >
                  Toutes les boutiques
                </button>
                {shops.map((s) => (
                  <button
                    key={s.id}
                    className="chip"
                    aria-pressed={shop === s.id}
                    onClick={() => setShop(s.id)}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            )}

            <div className="orders-search">
              <input
                type="text"
                className="input input--search"
                placeholder="Rechercher par acheteur, n° commande, transporteur…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  onClick={() => setSearch("")}
                >
                  Effacer
                </button>
              )}
            </div>
          </div>

          {/* Liste des commandes */}
          {filtered.length === 0 ? (
            <div className="empty" style={{ margin: "20px 0" }}>
              <span className="empty__t">Aucune commande ne correspond aux filtres</span>
              <span className="empty__d">Essayez d'ajuster le statut ou la recherche.</span>
            </div>
          ) : (
            <div className="rows">
              {filtered.map((o) => {
                const st = STATUS[o.status] ?? { label: o.status, cls: "pill--mute" };
                const canFulfill = o.status === "paid" || o.status === "pending";

                return (
                  <div className="row order-row-card" key={o.id}>
                    <span className="mono-badge">
                      {o.shopName.slice(0, 2).toUpperCase()}
                    </span>

                    <div className="row__main">
                      <div className="order-row__title-line">
                        <span className="order-buyer">{o.buyer ?? "Acheteur inconnu"}</span>
                        <span className="order-ext-id">{o.externalId}</span>
                      </div>
                      <div className="row__s">
                        {o.shopName} ({o.platform}) · {when(o.placedAt)}
                        {o.shippingCarrier && (
                          <span className="order-carrier-tag">
                            · <Icon name="truck" /> {o.shippingCarrier}
                            {o.trackingNumber && (
                              <b className="font-mono"> ({o.trackingNumber})</b>
                            )}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="row__end order-row__end-box">
                      <div className="order-price-status">
                        <span className="amount">{money(o.amount, o.currency)}</span>
                        <span className={`pill ${st.cls}`}>{st.label}</span>
                      </div>

                      {canFulfill ? (
                        <button
                          type="button"
                          className="btn btn--small btn--primary btn-fulfill-trigger"
                          onClick={() => setActiveFulfillmentOrderId(o.id)}
                        >
                          <Icon name="box" /> Exécuter la commande
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--small btn--ghost"
                          onClick={() => setActiveFulfillmentOrderId(o.id)}
                        >
                          <Icon name="check" /> Voir le détail
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* --- Modale d'exécution en 5 étapes --- */}
      {activeFulfillmentOrderId && (
        <FulfillmentModal
          orderId={activeFulfillmentOrderId}
          onClose={() => setActiveFulfillmentOrderId(null)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ["orders"] });
          }}
        />
      )}
    </>
  );
}
