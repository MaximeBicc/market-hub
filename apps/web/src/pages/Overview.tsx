import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, money, when, type Overview as O } from "../lib/api.js";
import { Empty } from "../components/Empty.js";
import { Icon } from "../components/Icon.js";
import { PalmLoader } from "../components/PalmLoader.js";
import { toast } from "../components/Toast.js";

/**
 * Les plateformes d'APPROVISIONNEMENT.
 *
 * Alibaba est reliée par le même mécanisme qu'une place de marché — mêmes
 * jetons, mêmes tâches de relevé — mais rien n'y est vendu. La compter parmi
 * les « boutiques actives » gonflait un chiffre censé répondre à « combien de
 * canaux de vente tournent ? ». Elle est donc séparée partout où l'interface
 * répond à cette question-là.
 */
const FOURNISSEURS = new Set(["alibaba"]);
const estFournisseur = (plateforme: string) => FOURNISSEURS.has(plateforme);

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
    /*
     * L'ACCUEIL SE RAFRAÎCHIT SEUL.
     *
     * Le bandeau de retard s'efface au premier relevé réussi — mais la page
     * ne le savait qu'au rechargement suivant. Après un incident réparé, on
     * restait donc devant une alerte périmée, sans moyen de distinguer « c'est
     * toujours cassé » de « l'écran date d'il y a une heure ». Le cron
     * d'empilement tourne à la minute : relire à ce rythme suffit à ce que
     * l'alerte s'éteigne d'elle-même, à la minute près.
     */
    refetchInterval: 60_000,
  });

  if (isLoading || !data) return <PalmLoader label="Chargement de l’accueil…" />;

  const noShops = data.shops.length === 0;
  const boutiques = data.shops.filter((s) => !estFournisseur(s.platform));
  const fournisseurs = data.shops.filter((s) => estFournisseur(s.platform));
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
  const compte = (id: string) => data.shops.find((s) => s.id === id);
  const nomBoutique = (id: string) => compte(id)?.name ?? id;

  const stale = data.health
    .filter((h) => {
      if (h.failureCount > 0) return true;
      if (h.lastOkAt === null) return false;
      const tolerance = Math.max(h.intervalSec * 3, 900);
      return maintenant - h.lastOkAt > tolerance;
    })
    // Les canaux de vente d'abord : une commande manquée coûte plus cher
    // qu'un catalogue fournisseur en retard.
    .sort(
      (a, b) =>
        Number(estFournisseur(compte(a.shopId)?.platform ?? "")) -
        Number(estFournisseur(compte(b.shopId)?.platform ?? "")),
    );

  /**
   * Quand la tâche repartira — dite en clair.
   *
   * Deux cas se ressemblent à l'écran et n'ont rien à voir : une échéance
   * dépassée parce que le cron va la prendre au prochain tour (tout va bien,
   * il faut juste attendre une minute), et une échéance dépassée parce que la
   * boutique n'est plus « active » — l'ordonnanceur la filtre alors, et
   * l'attente serait infinie. Les annoncer pareil serait mentir.
   */
  function prochaineTentative(h: O["health"][number]): string {
    if (compte(h.shopId)?.status !== "active") {
      return "relevé suspendu jusqu'à la reconnexion";
    }
    const dans = h.nextRunAt - maintenant;
    if (dans <= 60) return "nouvelle tentative imminente";
    if (dans < 3600) return `nouvelle tentative dans ${Math.round(dans / 60)} min`;
    const heures = Math.floor(dans / 3600);
    // Tronqué, pas arrondi : arrondir 59 min 40 donnerait « 1 h 60 ».
    const minutes = Math.floor((dans % 3600) / 60);
    return `nouvelle tentative dans ${heures} h${minutes > 0 ? ` ${minutes}` : ""}`;
  }

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
              value={String(boutiques.filter((s) => s.status === "active").length)}
              sub={`sur ${boutiques.length}`}
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
                  {estFournisseur(compte(h.shopId)?.platform ?? "") && (
                    <span className="pill pill--info banner__tag">Fournisseur</span>
                  )}
                  {nomBoutique(h.shopId)} · {h.resource} —{" "}
                  {h.lastOkAt ? `dernier succès ${when(h.lastOkAt)}` : "jamais synchronisé"}
                  {h.lastError ? ` · ${h.lastError}` : ""}
                  <b className="banner__next">{prochaineTentative(h)}</b>
                </span>
              ))}
              {/* Sans cette phrase, l'alerte se lit comme une chose à réparer
                  alors qu'elle se répare seule : le compteur d'échecs retombe
                  à zéro au premier relevé réussi, et le bandeau disparaît. */}
              <span className="banner__note">
                Ce bandeau s'efface tout seul au premier relevé réussi — la page
                se relit chaque minute, rien à recharger.
              </span>
            </div>
          )}

          {boutiques.length > 0 && (
            <>
              <h2 className="sec">
                Boutiques <span>{boutiques.length}</span>
              </h2>
              <div className="rows">
                {boutiques.map((s) => (
                  <Compte key={s.id} shop={s} onSync={sync} />
                ))}
              </div>
            </>
          )}

          {fournisseurs.length > 0 && (
            <>
              <h2 className="sec">
                Fournisseurs <span>{fournisseurs.length}</span>
              </h2>
              <div className="rows">
                {fournisseurs.map((s) => (
                  <Compte key={s.id} shop={s} onSync={sync} fournisseur />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * Une ligne de compte relié.
 *
 * Le liseré et le badge turquoise disent la seule chose qui compte au premier
 * coup d'œil : d'où vient l'argent, et d'où vient la marchandise.
 */
function Compte({
  shop,
  onSync,
  fournisseur,
}: {
  shop: O["shops"][number];
  onSync: (id: string, name: string) => Promise<void>;
  fournisseur?: boolean;
}) {
  return (
    <div className={fournisseur ? "row row--fournisseur" : "row"}>
      <span
        className={
          fournisseur ? "mono-badge mono-badge--fournisseur" : "mono-badge"
        }
      >
        {shop.name.slice(0, 2).toUpperCase()}
      </span>
      <div className="row__main">
        <div className="row__t">{shop.name}</div>
        <div className="row__s">
          {shop.platform}
          {fournisseur ? " · approvisionnement, pas un canal de vente" : ""}
        </div>
      </div>
      <button
        className="btn btn--small"
        onClick={() => void onSync(shop.id, shop.name)}
      >
        <Icon name="refresh" />
        Sync
      </button>
    </div>
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
