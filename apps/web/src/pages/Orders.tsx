import { useQuery } from "@tanstack/react-query";
import { api, money, when, type OrderRow } from "../lib/api.js";

/** Toutes les commandes, toutes boutiques confondues, du plus récent au plus ancien. */
export function Orders() {
  const { data, isLoading } = useQuery({
    queryKey: ["orders"],
    queryFn: () => api.get<{ orders: OrderRow[] }>("/orders"),
  });

  if (isLoading || !data) return <div className="boot">Chargement…</div>;

  return (
    <div className="page">
      <h1>Commandes</h1>
      <ul className="list">
        {data.orders.map((o) => (
          <li key={o.id} className="row">
            <span className={`badge badge--${o.platform}`}>{o.platform}</span>
            <div className="row__main">
              <div>{o.buyer ?? "Acheteur inconnu"}</div>
              <small>
                {when(o.placedAt)} · {o.shopName}
              </small>
            </div>
            <div className="row__end">
              <strong>{money(o.amount, o.currency)}</strong>
              <small className={`status status--${o.status}`}>{o.status}</small>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
