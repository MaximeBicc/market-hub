import { useQuery } from "@tanstack/react-query";
import { api, money } from "../lib/api.js";
import { Empty } from "../components/Empty.js";
import { PalmLoader } from "../components/PalmLoader.js";

interface GrowthData {
  days: Array<{ date: string; label: string; total: number; count: number }>;
  total: number;
  count: number;
  previousTotal: number;
  byShop: Array<{ shopId: string; name: string; platform: string; total: number; count: number }>;
}

/**
 * Croissance.
 *
 * Le graphique est en barres et non en courbe : le chiffre d'affaires
 * quotidien est une grandeur discrète — une valeur par jour, sans continuité
 * entre deux jours. Une courbe suggérerait une progression qui n'existe pas
 * entre lundi soir et mardi matin.
 *
 * Une seule série, donc pas de légende : le titre suffit à la nommer.
 */
export function Growth() {
  const { data, isLoading } = useQuery({
    queryKey: ["growth"],
    queryFn: () => api.get<GrowthData>("/growth?days=30"),
  });

  if (isLoading || !data) return <PalmLoader label="Chargement de la croissance…" />;

  if (data.count === 0) {
    return (
      <>
        <div className="page-head">
          <h1>Croissance</h1>
        </div>
        <Empty icon="chart" title="Pas encore de ventes à analyser">
          Les graphiques se construiront à partir de vos commandes réelles.
          Aucune donnée n'est simulée : cet écran restera vide tant qu'il n'y
          aura rien à montrer.
        </Empty>
      </>
    );
  }

  const max = Math.max(...data.days.map((d) => d.total), 1);
  const delta =
    data.previousTotal > 0
      ? Math.round(((data.total - data.previousTotal) / data.previousTotal) * 100)
      : null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Croissance</h1>
          <p>30 derniers jours</p>
        </div>
      </div>

      <div className="grid g3">
        <div className="card">
          <span className="stat__l">Chiffre d'affaires</span>
          <span className="stat__v">{money(data.total)}</span>
          {delta !== null && (
            <span
              className={`stat__d stat__d--${delta >= 0 ? "up" : "down"}`}
            >
              {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)} % vs 30 jours précédents
            </span>
          )}
        </div>
        <div className="card">
          <span className="stat__l">Commandes</span>
          <span className="stat__v">{data.count}</span>
          <span className="stat__d">sur la période</span>
        </div>
        <div className="card">
          <span className="stat__l">Panier moyen</span>
          <span className="stat__v">
            {money(Math.round(data.total / data.count))}
          </span>
          <span className="stat__d">par commande</span>
        </div>
      </div>

      <h2 className="sec">Chiffre d'affaires par jour</h2>
      <div className="card">
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 3,
            height: 130,
          }}
        >
          {data.days.map((d) => (
            <div
              key={d.date}
              title={`${d.label} — ${money(d.total)}`}
              style={{
                flex: 1,
                minWidth: 0,
                height: `${Math.max(2, (d.total / max) * 100)}%`,
                background: d.total > 0 ? "var(--accent)" : "var(--card-3)",
                borderRadius: "4px 4px 2px 2px",
              }}
            />
          ))}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 8,
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            color: "var(--muted)",
          }}
        >
          <span>{data.days[0]?.label}</span>
          <span>{data.days[data.days.length - 1]?.label}</span>
        </div>
      </div>

      {data.byShop.length > 1 && (
        <>
          <h2 className="sec">Répartition par boutique</h2>
          <div className="rows">
            {data.byShop.map((s) => (
              <div className="row" key={s.shopId}>
                <span className="mono-badge">
                  {s.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="row__main">
                  <div className="row__t">{s.name}</div>
                  <div className="row__s">
                    {s.platform} · {s.count} commande{s.count > 1 ? "s" : ""}
                  </div>
                </div>
                <div className="row__end">
                  <span className="amount">{money(s.total)}</span>
                  <span className="muted">
                    {Math.round((s.total / data.total) * 100)} %
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
