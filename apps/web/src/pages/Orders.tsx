import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, money, when, type OrderRow } from "../lib/api.js";
import { Empty } from "../components/Empty.js";

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "en attente", cls: "pill--warn" },
  paid: { label: "payée", cls: "pill--ok" },
  shipped: { label: "expédiée", cls: "pill--mute" },
  delivered: { label: "livrée", cls: "pill--mute" },
  cancelled: { label: "annulée", cls: "pill--stop" },
  refunded: { label: "remboursée", cls: "pill--stop" },
};

/** Toutes les commandes, toutes boutiques confondues, du plus récent au plus ancien. */
export function Orders() {
  const [shop, setShop] = useState("all");

  const { data, isLoading } = useQuery({
    queryKey: ["orders"],
    queryFn: () => api.get<{ orders: OrderRow[] }>("/orders"),
  });
  const { data: overview } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<import("../lib/api.js").Overview>("/overview"),
  });

  if (isLoading || !data) return <div className="boot">Chargement…</div>;

  const shops = overview?.shops ?? [];
  const list = shop === "all" ? data.orders : data.orders.filter((o) => o.shopId === shop);
  const total = list.reduce((s, o) => s + o.amount, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Commandes</h1>
          <p>
            {list.length === 0
              ? "Aucune commande"
              : `${list.length} commande${list.length > 1 ? "s" : ""} · ${money(total)}`}
          </p>
        </div>
      </div>

      {data.orders.length === 0 ? (
        <Empty
          icon="orders"
          title="Aucune commande pour l'instant"
          action={
            shops.length === 0 ? (
              <a className="btn btn--primary" href="/shops">
                Connecter une boutique
              </a>
            ) : undefined
          }
        >
          {shops.length === 0
            ? "Les commandes apparaîtront ici dès qu'une boutique sera reliée."
            : "Vos boutiques sont connectées. Les commandes remonteront à la prochaine synchronisation, ou immédiatement par webhook pour Shopify et eBay."}
        </Empty>
      ) : (
        <>
          {shops.length > 1 && (
            <div className="filters">
              <button
                className="chip"
                aria-pressed={shop === "all"}
                onClick={() => setShop("all")}
              >
                Toutes
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

          <div className="rows">
            {list.map((o) => {
              const st = STATUS[o.status] ?? { label: o.status, cls: "pill--mute" };
              return (
                <div className="row" key={o.id}>
                  <span className="mono-badge">
                    {o.shopName.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="row__main">
                    <div className="row__t">{o.buyer ?? "Acheteur inconnu"}</div>
                    <div className="row__s">
                      {o.platform} · {when(o.placedAt)}
                    </div>
                  </div>
                  <div className="row__end">
                    <span className="amount">{money(o.amount, o.currency)}</span>
                    <span className={`pill ${st.cls}`}>{st.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
