import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, money, when, type Overview as O } from "../lib/api.js";
import { Empty } from "../components/Empty.js";
import { Icon } from "../components/Icon.js";
import { toast } from "../components/Toast.js";

/**
 * Accueil.
 *
 * L'état de santé de la synchronisation est affiché ICI, pas caché dans les
 * réglages. Une boutique qui ne se synchronise plus est le mode de panne le
 * plus coûteux de cet outil, parce qu'il est silencieux : tout a l'air normal,
 * les chiffres sont simplement figés.
 */
export function Overview() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<O>("/overview"),
  });

  if (isLoading || !data) return <div className="boot">Chargement…</div>;

  const noShops = data.shops.length === 0;
  /*
   * QUAND UNE TÂCHE EST-ELLE VRAIMENT EN RETARD ?
   *
   * Le seuil était fixe : deux heures, pour toutes les ressources. Or leurs
   * rythmes n'ont rien à voir — le stock se relit toutes les deux minutes, le
   * catalogue complet une fois par jour. « listings » se déclarait donc en
   * retard vingt-deux heures sur vingt-quatre, et le bandeau d'alerte devenait
   * un décor qu'on apprend à ne plus lire.
   *
   * Le retard se juge maintenant contre le rythme PROPRE de chaque tâche :
   * trois cycles manqués. La marge de trois absorbe le repli exponentiel qui
   * suit un échec passager, sans masquer une panne installée.
   */
  const maintenant = Date.now() / 1000;
  const nomBoutique = (id: string) =>
    data.shops.find((s) => s.id === id)?.name ?? id;

  const stale = data.health.filter((h) => {
    if (h.failureCount > 0) return true;
    if (h.lastOkAt === null) return false;
    const tolerance = Math.max(h.intervalSec * 3, 900);
    return maintenant - h.lastOkAt > tolerance;
  });

  async function sync(shopId: string, name: string) {
    await api.post(`/sync/${shopId}`);
    toast(`Synchronisation de ${name} demandée`);
    qc.invalidateQueries({ queryKey: ["overview"] });
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Accueil</h1>
          <p>
            {new Intl.DateTimeFormat("fr-FR", {
              weekday: "long",
              day: "numeric",
              month: "long",
            }).format(new Date())}
          </p>
        </div>
      </div>

      {noShops ? (
        <Empty
          icon="plug"
          title="Aucune boutique connectée"
          action={
            <a className="btn btn--primary" href="/shops">
              Connecter une boutique
            </a>
          }
        >
          L'application est en ligne et la synchronisation tourne déjà toutes
          les cinq minutes — mais elle n'a rien à récupérer tant qu'aucune
          boutique n'est reliée.
        </Empty>
      ) : (
        <>
          <div className="grid g4">
            <Stat
              label="Chiffre du jour"
              value={money(data.today.total)}
              sub={`${data.today.count} commande${data.today.count > 1 ? "s" : ""}`}
            />
            <Stat
              label="Sur 7 jours"
              value={money(data.week.total)}
              sub={`${data.week.count} commande${data.week.count > 1 ? "s" : ""}`}
            />
            <Stat
              label="Boutiques actives"
              value={String(data.shops.filter((s) => s.status === "active").length)}
              sub={`sur ${data.shops.length}`}
            />
            <Stat
              label="Stock bas"
              value={String(data.lowStockCount)}
              sub={data.lowStockCount > 0 ? "à réapprovisionner" : "rien à signaler"}
              tone={data.lowStockCount > 0 ? "warn" : undefined}
            />
          </div>

          {data.needsAttention.length > 0 && (
            <div className="banner banner--stop">
              <span className="banner__t">Action requise</span>
              {data.needsAttention.map((s) => (
                <span className="banner__b" key={s.id}>
                  <b>{s.name}</b> —{" "}
                  {s.status === "reauth_required"
                    ? "reconnexion nécessaire, la synchronisation est arrêtée"
                    : s.status}
                </span>
              ))}
            </div>
          )}

          {stale.length > 0 && (
            <div className="banner banner--warn">
              <span className="banner__t">Synchronisation en retard</span>
              {stale.map((h) => (
                <span className="banner__b" key={h.shopId + h.resource}>
                  {/* Le nom de la boutique, pas seulement la ressource : avec
                      trois boutiques, « listings » seul ne dit pas laquelle. */}
                  {nomBoutique(h.shopId)} · {h.resource} —{" "}
                  {h.lastOkAt ? `dernier succès ${when(h.lastOkAt)}` : "jamais synchronisé"}
                  {h.lastError ? ` · ${h.lastError}` : ""}
                </span>
              ))}
            </div>
          )}

          <h2 className="sec">
            Boutiques <span>{data.shops.length}</span>
          </h2>
          <div className="rows">
            {data.shops.map((s) => (
              <div className="row" key={s.id}>
                <span className="mono-badge">
                  {s.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="row__main">
                  <div className="row__t">{s.name}</div>
                  <div className="row__s">{s.platform}</div>
                </div>
                <button
                  className="btn btn--small"
                  onClick={() => void sync(s.id, s.name)}
                >
                  <Icon name="refresh" />
                  Sync
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  tone?: "up" | "down" | "warn" | undefined;
}) {
  return (
    <div className="card">
      <span className="stat__l">{label}</span>
      <span className="stat__v">{value}</span>
      {sub && (
        <span className={tone ? `stat__d stat__d--${tone}` : "stat__d"}>
          {sub}
        </span>
      )}
    </div>
  );
}
