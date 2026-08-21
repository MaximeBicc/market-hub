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
  ["Allegro", "API REST complète, application à enregistrer."],
  ["Etsy", "Adaptateur à porter. Aucun bac à sable : tests en réel obligatoires."],
  ["TikTok Shop", "Validation Partner Center nécessaire, 2 à 3 jours."],
  ["Vinted", "Aucune API sans accès Vinted Pro. Détection des ventes par e-mail possible."],
] as const;

export function Shops() {
  const qc = useQueryClient();
  const [importing, setImporting] = useState<string | null>(null);
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

  /**
   * Import du catalogue existant.
   *
   * Relance tant qu'un curseur revient : une boutique de plusieurs milliers
   * de variantes ne tient pas dans une seule invocation, bornée à 50
   * sous-requêtes. La boucle est plafonnée pour qu'une pagination qui ne se
   * termine jamais ne tourne pas indéfiniment.
   */
  async function importer(accountId: string) {
    setImporting(accountId);
    try {
      let cursor: string | null = null;
      let produits = 0;
      let annonces = 0;
      let ventes = 0;
      let sansSku = 0;

      for (let page = 0; page < 20; page++) {
        const r: {
          produitsCrees: number;
          produitsExistants: number;
          annonces: number;
          sansSku: number;
          ventesMarquees: number;
          curseurSuivant: string | null;
        } = await api.post(
          `/engine/accounts/${accountId}/import${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        produits += r.produitsCrees;
        annonces += r.annonces;
        ventes += r.ventesMarquees;
        sansSku += r.sansSku;
        cursor = r.curseurSuivant;
        if (!cursor) break;
      }

      toast(
        `${annonces} annonce${annonces > 1 ? "s" : ""} importée${annonces > 1 ? "s" : ""} · ${produits} produit${produits > 1 ? "s" : ""} créé${produits > 1 ? "s" : ""}` +
          (sansSku > 0 ? ` · ${sansSku} sans SKU` : "") +
          (ventes > 0 ? ` · ${ventes} vente${ventes > 1 ? "s" : ""} enregistrée${ventes > 1 ? "s" : ""}` : ""),
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : "Import impossible");
    } finally {
      setImporting(null);
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    }
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
                      disabled={importing !== null}
                      onClick={() => void importer(a.id)}
                    >
                      {importing === a.id ? "Import…" : "Importer"}
                    </button>
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
      <ConnectEbay />

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

/**
 * Connexion eBay.
 *
 * Plus long que Shopify, et ce n'est pas évitable : les API vendeur d'eBay
 * exigent un jeton UTILISATEUR obtenu après consentement dans un navigateur.
 * On mémorise donc les identifiants, puis on renvoie vers eBay, qui nous
 * rappelle avec un code.
 */
function ConnectEbay() {
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [ruName, setRuName] = useState("");
  const [marketplaceId, setMarketplaceId] = useState("EBAY_FR");
  const [refreshToken, setRefreshToken] = useState("");
  /**
   * Deux voies, parce qu'eBay en offre deux.
   *
   * « jeton » : le portail eBay a déjà généré le couple de jetons, on le
   * colle. Le RuName n'a alors pas besoin de pointer vers nous, ce qui évite
   * l'erreur de configuration la plus fréquente.
   *
   * « redirection » : parcours classique, MarketHub renvoie vers eBay.
   */
  const [mode, setMode] = useState<"jeton" | "redirection">("jeton");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        className="btn btn--wide"
        style={{ marginTop: 9 }}
        onClick={() => setOpen(true)}
      >
        <Icon name="plug" />
        Relier un compte eBay
      </button>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (mode === "jeton") {
        await api.post("/engine/accounts/ebay/token", {
          clientId,
          clientSecret,
          refreshToken,
          marketplaceId,
        });
        setClientSecret("");
        setRefreshToken("");
        toast("Compte eBay relié");
        window.location.reload();
        return;
      }

      const r = await api.post<{ url: string }>("/engine/accounts/ebay/start", {
        clientId,
        clientSecret,
        ruName,
        marketplaceId,
      });
      // Les secrets quittent la mémoire du navigateur avant la redirection.
      setClientSecret("");
      window.location.href = r.url;
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Connexion impossible");
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ marginTop: 9 }} onSubmit={submit}>
      <h2 className="sec" style={{ marginTop: 0 }}>
        Relier eBay
      </h2>

      <div className="filters" style={{ paddingBottom: 10 }}>
        <button
          type="button"
          className="chip"
          aria-pressed={mode === "jeton"}
          onClick={() => setMode("jeton")}
        >
          Coller un jeton
        </button>
        <button
          type="button"
          className="chip"
          aria-pressed={mode === "redirection"}
          onClick={() => setMode("redirection")}
        >
          Passer par eBay
        </button>
      </div>

      {mode === "jeton" ? (
        <div className="banner banner--info" style={{ marginTop: 0 }}>
          <span className="banner__t">La voie la plus courte</span>
          <span className="banner__b">
            Dans le portail eBay, à côté de votre App ID, cliquez{" "}
            <b>User Tokens</b> → <b>Get a Token from eBay via Your Application</b>.
            eBay vous fera créer un RuName au passage, puis vous donnera un{" "}
            <b>refresh token</b>. Collez-le ici : peu importe alors vers quoi
            pointe le RuName.
          </span>
        </div>
      ) : (
        <div className="banner banner--info" style={{ marginTop: 0 }}>
          <span className="banner__t">Le piège du RuName</span>
          <span className="banner__b">
            eBay n'attend pas une URL de retour mais un <b>RuName</b>. Cette
            voie exige d'y configurer l'URL d'acceptation vers{" "}
            <code>/api/engine/accounts/ebay/callback</code>. C'est l'endroit où
            l'on se trompe le plus souvent.
          </span>
        </div>
      )}

      {err && <div className="login__err">{err}</div>}

      <div className="field">
        <label htmlFor="ec">ID client (App ID)</label>
        <input
          id="ec"
          className="input"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
      </div>

      <div className="field">
        <label htmlFor="es">Secret client (Cert ID)</label>
        <input
          id="es"
          className="input"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
      </div>

      {mode === "jeton" ? (
        <div className="field">
          <label htmlFor="et">Jeton de rafraîchissement</label>
          <input
            id="et"
            className="input"
            type="password"
            placeholder="v^1.1#i^1#…"
            value={refreshToken}
            onChange={(e) => setRefreshToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <span className="muted">
            Le <b>refresh token</b>, pas le jeton d'accès : celui-ci vaut
            18 mois, l'autre 2 heures.
          </span>
        </div>
      ) : (
        <div className="field">
          <label htmlFor="er">RuName</label>
          <input
            id="er"
            className="input"
            placeholder="Prenom-Nom-appnam-abcdef"
            value={ruName}
            onChange={(e) => setRuName(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>
      )}

      <div className="field">
        <label htmlFor="em">Place de marché</label>
        <select
          id="em"
          className="input"
          value={marketplaceId}
          onChange={(e) => setMarketplaceId(e.target.value)}
        >
          <option value="EBAY_FR">France</option>
          <option value="EBAY_DE">Allemagne</option>
          <option value="EBAY_GB">Royaume-Uni</option>
          <option value="EBAY_US">États-Unis</option>
          <option value="EBAY_IT">Italie</option>
          <option value="EBAY_ES">Espagne</option>
        </select>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy
            ? "Vérification…"
            : mode === "jeton"
              ? "Tester et connecter"
              : "Autoriser sur eBay"}
        </button>
        <button
          className="btn btn--ghost"
          type="button"
          onClick={() => {
            setClientSecret("");
            setOpen(false);
          }}
        >
          Annuler
        </button>
      </div>

      <p className="muted" style={{ margin: "12px 0 0", lineHeight: 1.55 }}>
        Le jeton d'accès dure deux heures et se renouvelle tout seul pendant
        dix-huit mois. Passé ce délai, il faudra réautoriser le compte.
      </p>
    </form>
  );
}
