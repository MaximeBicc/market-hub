import { useQuery } from "@tanstack/react-query";
import { api, money, when, type Overview as O } from "../lib/api.js";

/**
 * Écran d'accueil : ce qu'on veut savoir en trois secondes.
 *
 * L'état de santé de la synchronisation est affiché ICI plutôt que caché dans
 * les réglages. Une boutique qui ne se synchronise plus doit se voir tout de
 * suite : c'est le mode de panne le plus coûteux d'un outil de ce genre, parce
 * qu'il est silencieux — tout a l'air normal, les chiffres sont juste figés.
 */
export function Overview() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<O>("/overview"),
  });

  if (isLoading || !data) return <div className="boot">Chargement…</div>;

  const stale = data.health.filter(
    (h) =>
      h.failureCount > 0 || !h.lastOkAt || Date.now() / 1000 - h.lastOkAt > 7200,
  );

  return (
    <div className="page">
      <h1>Aujourd&apos;hui</h1>

      <div className="cards">
        <Card label="Commandes du jour" value={String(data.today.count)} />
        <Card label="Chiffre du jour" value={money(data.today.total)} />
        <Card label="Sur 7 jours" value={money(data.week.total)} />
        <Card
          label="Stock bas"
          value={String(data.lowStockCount)}
          warn={data.lowStockCount > 0}
        />
      </div>

      {data.needsAttention.length > 0 && (
        <section className="alert">
          <strong>Action requise</strong>
          {data.needsAttention.map((s) => (
            <p key={s.id}>
              {s.name} :{" "}
              {s.status === "reauth_required"
                ? "reconnexion nécessaire"
                : s.status}
            </p>
          ))}
        </section>
      )}

      {stale.length > 0 && (
        <section className="alert alert--warn">
          <strong>Synchronisation en retard</strong>
          {stale.map((h) => (
            <p key={h.shopId + h.resource}>
              {h.resource} —{" "}
              {h.lastOkAt ? `dernier succès ${when(h.lastOkAt)}` : "jamais"}
              {h.lastError ? ` · ${h.lastError}` : ""}
            </p>
          ))}
        </section>
      )}

      <h2>Boutiques</h2>
      <ul className="list">
        {data.shops.map((s) => (
          <li key={s.id} className="row">
            <span className={`badge badge--${s.platform}`}>{s.platform}</span>
            <span className="row__main">{s.name}</span>
            <button
              className="btn btn--ghost"
              onClick={() => api.post(`/sync/${s.id}`).then(() => refetch())}
            >
              Synchroniser
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Card({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className={warn ? "card card--warn" : "card"}>
      <div className="card__value">{value}</div>
      <div className="card__label">{label}</div>
    </div>
  );
}
