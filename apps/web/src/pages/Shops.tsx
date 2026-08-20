import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { Empty } from "../components/Empty.js";
import { Icon } from "../components/Icon.js";
import { toast } from "../components/Toast.js";

interface Account {
  id: string;
  marketplace: string;
  slug: string | null;
  displayName: string;
  externalId: string;
  status: string;
  connectedAt: number;
}

const STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: "connectée", cls: "pill--ok" },
  connecting: { label: "connexion…", cls: "pill--warn" },
  error: { label: "en erreur", cls: "pill--stop" },
  paused: { label: "en pause", cls: "pill--mute" },
  reauth_required: { label: "à reconnecter", cls: "pill--stop" },
};

/** Plateformes dont l'adaptateur n'est pas encore écrit. */
const A_VENIR = [
  ["eBay", "OAuth et lecture faits ; signature des notifications à finir."],
  ["Allegro", "API REST complète, application à enregistrer."],
  ["Etsy", "Adaptateur à porter. Aucun bac à sable : tests en réel obligatoires."],
  ["TikTok Shop", "Validation Partner Center nécessaire, 2 à 3 jours."],
  ["Vinted", "Aucune API sans accès Vinted Pro. Détection des ventes par e-mail possible."],
] as const;

export function Shops() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<{ accounts: Account[] }>("/engine/accounts"),
  });

  if (isLoading || !data) return <div className="boot">Chargement…</div>;

  async function act(path: string, ok: string) {
    try {
      await api.post(path);
      toast(ok);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Échec");
    }
    qc.invalidateQueries({ queryKey: ["accounts"] });
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Boutiques</h1>
          <p>
            {data.accounts.length === 0
              ? "Aucune boutique reliée"
              : `${data.accounts.length} reliée${data.accounts.length > 1 ? "s" : ""}`}
          </p>
        </div>
      </div>

      {data.accounts.length === 0 ? (
        <Empty icon="plug" title="Aucune boutique reliée">
          Reliez votre boutique Shopify ci-dessous. Il faut d'abord avoir créé
          une application dans le Dev Dashboard de Shopify, et l'avoir installée
          sur la boutique.
        </Empty>
      ) : (
        <div className="rows">
          {data.accounts.map((a) => {
            const st = STATUS[a.status] ?? { label: a.status, cls: "pill--mute" };
            return (
              <div className="row" key={a.id}>
                <span className="mono-badge">
                  {a.displayName.slice(0, 2).toUpperCase()}
                </span>
                <div className="row__main">
                  <div className="row__t">{a.displayName}</div>
                  <div className="row__s">
                    {a.marketplace} · {a.externalId}
                  </div>
                </div>
                <div className="row__end">
                  <span className={`pill ${st.cls}`}>{st.label}</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      className="btn btn--small"
                      onClick={() =>
                        void act(`/engine/accounts/${a.id}/test`, "Connexion vérifiée")
                      }
                    >
                      Tester
                    </button>
                    {a.status === "paused" ? (
                      <button
                        className="btn btn--small"
                        onClick={() =>
                          void act(`/engine/accounts/${a.id}/resume`, "Compte réactivé")
                        }
                      >
                        Réactiver
                      </button>
                    ) : (
                      <button
                        className="btn btn--small btn--ghost"
                        onClick={() =>
                          void act(`/engine/accounts/${a.id}/pause`, "Compte mis en pause")
                        }
                      >
                        Pause
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConnectShopify onDone={() => qc.invalidateQueries({ queryKey: ["accounts"] })} />

      <h2 className="sec">Pas encore disponibles</h2>
      <div className="card planned" style={{ display: "grid", gap: 12 }}>
        {A_VENIR.map(([nom, note]) => (
          <div key={nom}>
            <div className="row__t">{nom}</div>
            <div className="row__s" style={{ whiteSpace: "normal", lineHeight: 1.45 }}>
              {note}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * Formulaire de connexion Shopify.
 *
 * Le jeton est saisi ici et n'en ressort jamais : il est chiffré côté serveur
 * avant d'atteindre la base, et aucune route ne le renvoie. C'est aussi pour
 * cela qu'il ne doit transiter par aucune conversation ni aucun fichier.
 */
function ConnectShopify({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [domain, setDomain] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        className="btn btn--primary btn--wide"
        style={{ marginTop: 14 }}
        onClick={() => setOpen(true)}
      >
        <Icon name="plug" />
        Relier une boutique Shopify
      </button>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post("/engine/accounts/shopify", {
        shopDomain: domain,
        clientId,
        clientSecret,
        webhookSecret: secret || undefined,
      });
      toast("Boutique Shopify connectée");
      // Les secrets sont effacés de la mémoire du navigateur dès qu'ils sont partis.
      setClientSecret("");
      setSecret("");
      setOpen(false);
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Connexion impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ marginTop: 14 }} onSubmit={submit}>
      <h2 className="sec" style={{ marginTop: 0 }}>
        Relier Shopify
      </h2>

      <div className="banner banner--info" style={{ marginTop: 0 }}>
        <span className="banner__t">Où trouver ces valeurs</span>
        <span className="banner__b">
          Dev Dashboard → votre application → <b>Paramètres</b> → <b>Identifiants</b>.
          L'application doit d'abord être <b>installée sur la boutique</b>, sinon
          Shopify refusera l'échange.
        </span>
      </div>

      {err && <div className="login__err">{err}</div>}

      <div className="field">
        <label htmlFor="sd">Domaine de la boutique</label>
        <input
          id="sd"
          className="input"
          placeholder="maboutique.myshopify.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
        <span className="muted">
          Le domaine <code>.myshopify.com</code>, pas votre domaine personnalisé.
        </span>
      </div>

      <div className="field">
        <label htmlFor="ci">ID client</label>
        <input
          id="ci"
          className="input"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
      </div>

      <div className="field">
        <label htmlFor="cs">Secret client</label>
        <input
          id="cs"
          className="input"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          // Pas un mot de passe de connexion : on ne veut ni proposition de
          // remplissage, ni enregistrement dans le gestionnaire du navigateur.
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
        <span className="muted">
          Chiffré avant enregistrement. Il ne sera plus jamais affiché, même à vous.
        </span>
      </div>

      <div className="field">
        <label htmlFor="ws">Secret de webhook (facultatif)</label>
        <input
          id="ws"
          className="input"
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="muted">
          Nécessaire uniquement pour recevoir les ventes en temps réel. Sans lui,
          le relevé périodique prend le relais.
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? "Vérification…" : "Tester et connecter"}
        </button>
        <button
          className="btn btn--ghost"
          type="button"
          onClick={() => {
            setClientSecret("");
            setSecret("");
            setOpen(false);
          }}
        >
          Annuler
        </button>
      </div>

      <p className="muted" style={{ margin: "12px 0 0", lineHeight: 1.55 }}>
        La connexion est testée avant d'être enregistrée : des identifiants
        invalides laissent la boutique en erreur plutôt que de la faire passer
        pour reliée. Le jeton d'accès dure 24 heures et se renouvelle tout seul.
      </p>
    </form>
  );
}
