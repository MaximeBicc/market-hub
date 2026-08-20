import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { checkPushStatus, subscribeToPush, type PushStatus } from "../lib/push.js";
import { Icon } from "../components/Icon.js";
import { toast } from "../components/Toast.js";

/**
 * Réglages : compte, mot de passe, notifications, IA, feuille de route.
 *
 * La section « à construire » est volontairement présente. Un produit qui
 * cache ce qu'il ne sait pas encore faire pousse à le redécouvrir écran par
 * écran ; l'afficher permet d'arbitrer ce qui vient ensuite.
 */
export function Settings() {
  const [push, setPush] = useState<PushStatus | null>(null);
  useEffect(() => {
    void checkPushStatus().then(setPush);
  }, []);

  const { data: me } = useQuery({
    queryKey: ["auth"],
    queryFn: () =>
      api.get<{ username: string; displayName: string }>("/auth/state"),
  });
  const { data: usage } = useQuery({
    queryKey: ["ai-usage"],
    queryFn: () =>
      api.get<{ outputTokensUsed: number; limit: number; estimatedCostUsd: string }>(
        "/ai/usage",
      ),
    retry: false,
  });

  return (
    <>
      <div className="page-head">
        <h1>Réglages</h1>
      </div>

      <h2 className="sec">Compte</h2>
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="mono-badge">{me?.displayName ?? "—"}</span>
          <div className="row__main">
            <div className="row__t">{me?.displayName}</div>
            <div className="row__s">{me?.username}</div>
          </div>
        </div>
      </div>

      <ChangePassword />

      <h2 className="sec">Notifications</h2>
      <div className="card">
        {push?.state === "ready" && (
          <>
            <p className="muted" style={{ color: "var(--ok)", margin: "0 0 12px" }}>
              Actives sur cet appareil.
            </p>
            <button
              className="btn btn--wide"
              onClick={async () => {
                const r = await api.post<{ sent: number }>("/push/test");
                toast(
                  r.sent > 0
                    ? "Notification envoyée"
                    : "Aucun appareil n'a reçu la notification",
                );
              }}
            >
              <Icon name="bell" />
              Envoyer un test
            </button>
          </>
        )}
        {push?.state === "not-subscribed" && (
          <>
            <p className="muted" style={{ margin: "0 0 12px" }}>
              Une alerte à chaque commande, en rupture de stock, ou quand une
              boutique demande une reconnexion.
            </p>
            <button
              className="btn btn--primary btn--wide"
              onClick={() => void subscribeToPush().then(setPush)}
            >
              <Icon name="bell" />
              Activer les notifications
            </button>
          </>
        )}
        {push?.state === "needs-install" && (
          <div className="banner banner--warn" style={{ margin: 0 }}>
            <span className="banner__t">Une étape de plus sur iPhone</span>
            <span className="banner__b">{push.reason}</span>
          </div>
        )}
        {(push?.state === "denied" || push?.state === "unsupported") && (
          <p className="muted" style={{ margin: 0 }}>
            {push.reason}
          </p>
        )}
      </div>

      <h2 className="sec">Assistant IA</h2>
      <div className="card">
        {usage ? (
          <>
            <span className="stat__l">Consommation du mois</span>
            <span className="stat__v">
              {usage.outputTokensUsed.toLocaleString("fr-FR")}
            </span>
            <span className="stat__d">
              sur {usage.limit.toLocaleString("fr-FR")} jetons — environ{" "}
              {usage.estimatedCostUsd} $
            </span>
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Non configuré. C'est le seul poste payant du projet, et il est
            optionnel : le plafond mensuel est appliqué côté serveur.
          </p>
        )}
      </div>

      <h2 className="sec">Prévu, pas encore construit</h2>
      <div className="card planned" style={{ display: "grid", gap: 12 }}>
        {[
          ["Achats et conteneurs", "Commandes fournisseur, suivi des conteneurs, coût de revient rendu."],
          ["Produit maître", "Un produit, plusieurs annonces : propagation du stock entre canaux."],
          ["Rentabilité par commande", "Marge réelle après frais de plateforme, port et achat."],
          ["Suivi des colis", "État des expéditions et retours, toutes plateformes confondues."],
          ["Avis et messages", "Centralisation des avis clients et des messages acheteurs."],
          ["Calendrier", "Échéances, arrivées de conteneurs, opérations commerciales."],
        ].map(([t, d]) => (
          <div key={t}>
            <div className="row__t">{t}</div>
            <div className="row__s" style={{ whiteSpace: "normal", lineHeight: 1.45 }}>
              {d}
            </div>
          </div>
        ))}
        <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
          Chacune demande un modèle de données qui n'existe pas encore. Dites
          laquelle compte le plus et je la construis.
        </p>
      </div>

      <h2 className="sec">Session</h2>
      <button
        className="btn btn--wide btn--ghost"
        onClick={async () => {
          await api.post("/auth/logout");
          window.location.href = "/";
        }}
      >
        Se déconnecter
      </button>
    </>
  );
}

function ChangePassword() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        className="btn btn--wide"
        style={{ marginTop: 8 }}
        onClick={() => setOpen(true)}
      >
        <Icon name="lock" />
        Changer le mot de passe
      </button>
    );
  }

  return (
    <form
      className="card"
      style={{ marginTop: 8 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await api.post("/auth/password", { current, next });
          toast("Mot de passe changé. Vos autres sessions sont fermées.");
          setOpen(false);
          setCurrent("");
          setNext("");
        } catch (e2) {
          setErr(e2 instanceof Error ? e2.message : "Échec");
        } finally {
          setBusy(false);
        }
      }}
    >
      {err && <div className="login__err">{err}</div>}
      <div className="field">
        <label htmlFor="cp">Mot de passe actuel</label>
        <input
          id="cp"
          className="input"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="np">Nouveau mot de passe (12 caractères minimum)</label>
        <input
          id="np"
          className="input"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn--primary" type="submit" disabled={busy}>
          Enregistrer
        </button>
        <button
          className="btn btn--ghost"
          type="button"
          onClick={() => setOpen(false)}
        >
          Annuler
        </button>
      </div>
      <p className="muted" style={{ margin: "10px 0 0", lineHeight: 1.5 }}>
        Le mot de passe généré est aléatoire sur 24 caractères. Un mot de passe
        choisi à la main sera presque toujours plus faible — ne changez que si
        vous le stockez dans un gestionnaire.
      </p>
    </form>
  );
}
