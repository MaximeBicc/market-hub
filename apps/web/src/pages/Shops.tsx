import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, when, type Overview } from "../lib/api.js";
import { Empty } from "../components/Empty.js";
import { Icon } from "../components/Icon.js";
import { toast } from "../components/Toast.js";

const PLATFORMS = [
  {
    id: "shopify",
    label: "Shopify",
    needsShop: true,
    note: "Connecteur complet. Webhooks temps réel.",
  },
  {
    id: "etsy",
    label: "Etsy",
    needsShop: false,
    note: "Connecteur complet. Pas de webhooks : relevé toutes les 10 min.",
  },
  {
    id: "ebay",
    label: "eBay",
    needsShop: false,
    note: "Lecture des commandes et du stock. Notifications non vérifiées.",
  },
  {
    id: "alibaba",
    label: "Alibaba",
    needsShop: false,
    note: "Authentification seule. Cartographie des données à faire.",
  },
] as const;

/** Connexion et santé des boutiques. */
export function Shops() {
  const qc = useQueryClient();
  const [domain, setDomain] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<Overview>("/overview"),
  });

  if (isLoading || !data) return <div className="boot">Chargement…</div>;

  const healthOf = (shopId: string) =>
    data.health.filter((h) => h.shopId === shopId);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Boutiques</h1>
          <p>
            {data.shops.length === 0
              ? "Aucune boutique reliée"
              : `${data.shops.length} reliée${data.shops.length > 1 ? "s" : ""}`}
          </p>
        </div>
      </div>

      {data.shops.length === 0 ? (
        <Empty icon="plug" title="Aucune boutique reliée">
          Reliez votre première boutique ci-dessous. Il faut d'abord avoir
          enregistré une application chez la plateforme pour obtenir ses
          identifiants — sans eux, l'autorisation échouera.
        </Empty>
      ) : (
        <div className="rows">
          {data.shops.map((s) => {
            const h = healthOf(s.id);
            const lastOk = h.map((x) => x.lastOkAt ?? 0).sort().pop() ?? 0;
            const failing = h.some((x) => x.failureCount > 0);
            return (
              <div className="row" key={s.id}>
                <span className="mono-badge">
                  {s.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="row__main">
                  <div className="row__t">{s.name}</div>
                  <div className="row__s">
                    {s.platform} ·{" "}
                    {lastOk ? `sync ${when(lastOk)}` : "jamais synchronisée"}
                  </div>
                </div>
                <div className="row__end">
                  <span
                    className={
                      s.status === "active"
                        ? failing
                          ? "pill pill--warn"
                          : "pill pill--ok"
                        : "pill pill--stop"
                    }
                  >
                    {s.status === "active"
                      ? failing
                        ? "en erreur"
                        : "active"
                      : s.status === "reauth_required"
                        ? "à reconnecter"
                        : s.status}
                  </span>
                  <button
                    className="btn btn--small"
                    onClick={async () => {
                      await api.post(`/sync/${s.id}`);
                      toast(`Synchronisation de ${s.name} demandée`);
                      qc.invalidateQueries({ queryKey: ["overview"] });
                    }}
                  >
                    <Icon name="refresh" />
                    Sync
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h2 className="sec">Relier une boutique</h2>
      <div className="rows">
        {PLATFORMS.map((p) => (
          <div className="row" key={p.id} style={{ alignItems: "flex-start" }}>
            <div className="row__main">
              <div className="row__t">{p.label}</div>
              <div
                className="row__s"
                style={{ whiteSpace: "normal", lineHeight: 1.45 }}
              >
                {p.note}
              </div>
              {p.needsShop && (
                <input
                  className="input"
                  style={{ marginTop: 8, minHeight: 38, fontSize: 14 }}
                  placeholder="maboutique.myshopify.com"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  autoCapitalize="none"
                  spellCheck={false}
                />
              )}
            </div>
            <a
              className="btn btn--small"
              href={`/api/oauth/${p.id}/start${
                p.needsShop ? `?shop=${encodeURIComponent(domain)}` : ""
              }`}
            >
              Relier
            </a>
          </div>
        ))}
      </div>

      <div className="banner banner--info" style={{ marginTop: 16 }}>
        <span className="banner__t">Avant de relier</span>
        <span className="banner__b">
          Chaque plateforme exige d'enregistrer une application dans son portail
          développeur, puis d'y déclarer l'adresse de retour{" "}
          <code>/api/oauth/&#123;plateforme&#125;/callback</code>. Les
          identifiants obtenus se posent en secrets côté serveur. Sans cette
          étape, le bouton « Relier » aboutira à une erreur de la plateforme.
        </span>
      </div>
    </>
  );
}
