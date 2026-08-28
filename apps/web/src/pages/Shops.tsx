import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { Empty } from "../components/Empty.js";
import { Icon } from "../components/Icon.js";
import { PalmLoader } from "../components/PalmLoader.js";
import { toast } from "../components/Toast.js";

interface Account {
  id: string;
  marketplace: string;
  slug: string | null;
  displayName: string;
  externalId: string;
  status: string;
  connectedAt: number;
  jeton?: {
    /** Secondes avant expiration du jeton d'accès. Court par nature. */
    accesExpireDansSec: number | null;
    /**
     * Jours avant qu'une réautorisation au navigateur devienne obligatoire.
     * `null` quand la plateforme n'a pas de jeton de rafraîchissement —
     * Shopify régénère le sien tout seul, il n'y a rien à surveiller.
     */
    reautoriserDansJours: number | null;
  };
}

/**
 * L'échéance d'un jeton, dite en clair.
 *
 * C'est la panne la plus traître de l'outil : un jeton Etsy vit 90 jours, et
 * passé ce délai la boutique cesse de synchroniser sans que rien n'ait l'air
 * cassé. L'afficher en permanence vaut mieux qu'une alerte qui arrive trop
 * tard — et le seuil de quinze jours laisse le temps d'agir sans presser.
 */
function Echeance({ jeton }: { jeton: Account["jeton"] }) {
  if (!jeton) return null;

  const j = jeton.reautoriserDansJours;
  if (j === null) {
    return (
      <span className="muted">
        · jeton renouvelé automatiquement, sans échéance
      </span>
    );
  }

  const urgent = j <= 15;
  return (
    <span
      className="muted"
      style={urgent ? { color: "var(--warn)", fontWeight: 500 } : undefined}
    >
      ·{" "}
      {j <= 0
        ? "jeton expiré — reconnexion nécessaire"
        : `à réautoriser dans ${j} jour${j > 1 ? "s" : ""}`}
    </span>
  );
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
  ["TikTok Shop", "Validation Partner Center nécessaire, 2 à 3 jours."],
  ["Vinted", "Aucune API sans accès Vinted Pro. Détection des ventes par e-mail possible."],
] as const;

export function Shops() {
  /** Boutique dont le nom est en cours d'édition, le cas échéant. */
  const [edite, setEdite] = useState<string | null>(null);
  /** Boutique dont on déplie les réglages de compte. */
  const [reglages, setReglages] = useState<string | null>(null);
  const qc = useQueryClient();
  const [importing, setImporting] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<{ accounts: Account[] }>("/engine/accounts"),
  });

  if (isLoading || !data) return <PalmLoader label="Chargement des boutiques…" />;

  /**
   * Demande à la plateforme de pousser ses événements.
   *
   * Le bouton est explicite parce que l'action l'est : elle crée des
   * abonnements DANS la boutique distante. Le faire en silence à la connexion
   * reviendrait à modifier un compte marchand sans le dire.
   */
  async function tempsReel(a: Account) {
    try {
      const r = await api.post<{
        crees: string[];
        dejaLa: string[];
        echecs: Array<{ topic: string; message: string }>;
      }>(`/engine/accounts/${a.id}/temps-reel`);

      const poses = r.crees.length + r.dejaLa.length;
      toast(
        r.echecs.length > 0
          ? `${poses} abonnement(s) actif(s), ${r.echecs.length} refusé(s) — ${r.echecs[0]?.message ?? ""}`
          : `Temps réel actif — ${poses} abonnement(s), dont le stock`,
      );
      await qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Activation impossible");
    }
  }

  /**
   * REFAIRE LE CONSENTEMENT SANS RIEN PERDRE.
   *
   * Il faut parfois repasser par l'autorisation — quand une portée s'ajoute,
   * le jeton d'hier ne la porte pas, et aucune autre manœuvre ne l'obtient.
   * Sans ce bouton, le seul geste disponible était « Supprimer puis
   * recréer », qui perdait les réglages marchands et détachait les annonces.
   *
   * Ici la boutique garde son identité : seul le consentement est refait.
   */
  async function reconnecter(a: Account) {
    try {
      const r = await api.post<{ url: string }>(
        `/engine/accounts/${a.id}/reconnecter`,
      );
      if (!r?.url) throw new Error("Aucune adresse d'autorisation reçue");
      // La plateforme demande le consentement dans sa propre page ; le retour
      // se fait sur notre adresse de rappel, qui retrouve la boutique.
      window.location.href = r.url;
    } catch (e) {
      toast(e instanceof Error ? e.message : "Reconnexion impossible");
    }
  }

  /**
   * Suppression définitive d'une boutique.
   *
   * La confirmation nomme la boutique plutôt que de demander « êtes-vous
   * sûr ? » : sur une liste de plusieurs comptes, la seule question qui
   * compte est de savoir lequel on s'apprête à effacer. Le catalogue maître
   * n'est pas touché, et le message le dit — sinon on hésite à cliquer.
   */
  async function supprimer(a: Account) {
    if (
      !window.confirm(
        `Supprimer « ${a.displayName} » ?\n\n` +
          "Ses annonces, commandes et jetons seront effacés. " +
          "Les produits et le stock central sont conservés.",
      )
    ) {
      return;
    }
    try {
      const r = await api.del<{ supprime: string; produitsSansAnnonce: number }>(
        `/engine/accounts/${a.id}`,
      );
      toast(
        r.produitsSansAnnonce > 0
          ? `${r.supprime} supprimée · ${r.produitsSansAnnonce} produit(s) sans annonce`
          : `${r.supprime} supprimée`,
      );
      await qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Suppression impossible");
    }
  }

  /**
   * Renomme une boutique.
   *
   * Le nom n'a aucun rôle technique — le rapprochement se fait sur
   * l'identifiant distant. Il n'y a donc rien à confirmer : on modifie, et si
   * le serveur refuse, le nom revient de lui-même au rechargement.
   */
  async function renommer(a: Account, nom: string) {
    const propre = nom.trim();
    if (!propre || propre === a.displayName) return;
    try {
      await api.patch(`/engine/accounts/${a.id}`, { displayName: propre });
      await qc.invalidateQueries({ queryKey: ["accounts"] });
      await qc.invalidateQueries({ queryKey: ["catalogue"] });
      toast("Nom modifié");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Renommage impossible");
    }
  }

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

      <RetourOAuth />

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
                  <div className="row__t">
                    {edite === a.id ? (
                      <input
                        className="input"
                        style={{ maxWidth: 260, padding: "4px 8px" }}
                        defaultValue={a.displayName}
                        autoFocus
                        maxLength={60}
                        onBlur={(e) => {
                          void renommer(a, e.target.value);
                          setEdite(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") setEdite(null);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="renommer"
                        title="Renommer"
                        onClick={() => setEdite(a.id)}
                      >
                        {a.displayName}
                        <Icon name="pencil" />
                      </button>
                    )}
                  </div>
                  <div className="row__s">
                    {a.marketplace} · {a.externalId} <Echeance jeton={a.jeton} />
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
                    <button
                      className="btn btn--small"
                      onClick={() => setReglages(reglages === a.id ? null : a.id)}
                    >
                      Réglages
                    </button>
                    <button
                      className="btn btn--small"
                      onClick={() => void tempsReel(a)}
                    >
                      Temps réel
                    </button>
                    <button
                      className="btn btn--small"
                      title="Refaire le consentement sans rien perdre : la boutique garde ses réglages, ses annonces et son stock"
                      onClick={() => void reconnecter(a)}
                    >
                      Reconnecter
                    </button>
                    <button
                      className="btn btn--small btn--ghost"
                      onClick={() => void supprimer(a)}
                    >
                      Supprimer
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {reglages && (
        <Reglages
          accountId={reglages}
          onFerme={() => setReglages(null)}
        />
      )}

      <ConnectShopify onDone={() => qc.invalidateQueries({ queryKey: ["accounts"] })} />
      <ConnectEbay />
      <ConnectEtsy />

      <Catalogue />

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
  const [environment, setEnvironment] = useState("production");
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
          environment,
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
        environment,
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
        <label htmlFor="ee">Environnement</label>
        <select
          id="ee"
          className="input"
          value={environment}
          onChange={(e) => setEnvironment(e.target.value)}
        >
          <option value="production">Production — vraies annonces</option>
          <option value="sandbox">Bac à sable — pour essayer sans risque</option>
        </select>
        <span className="muted">
          Les deux environnements ont des identifiants distincts. Un jeton de
          bac à sable présenté à la production est refusé, et l'inverse aussi.
        </span>
      </div>

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

/**
 * Ce que dit la page au retour d'un parcours OAuth.
 *
 * Sans ce bandeau, un échec de connexion ramène sur une page d'apparence
 * normale avec un paramètre d'URL que personne ne lit : l'utilisateur croit
 * avoir réussi et découvre le contraire des heures plus tard. Le paramètre
 * est effacé de l'URL après lecture, pour qu'un rafraîchissement ne
 * ressuscite pas un message périmé.
 */
function RetourOAuth() {
  const [msg] = useState(() => {
    if (typeof window === "undefined") return null;
    const p = new URLSearchParams(window.location.search);
    const relie = p.get("relie");
    const erreur = p.get("erreur");
    const detail = p.get("detail");
    if (!relie && !erreur) return null;

    window.history.replaceState({}, "", window.location.pathname);

    if (relie) {
      return {
        ok: true,
        titre: "Boutique reliée",
        corps: `La connexion ${relie} est enregistrée. Lancez « Importer » pour reprendre le catalogue existant.`,
      };
    }
    const corps: Record<string, string> = {
      expire:
        "Le lien de connexion a expiré (10 minutes). Relancez le parcours depuis le début.",
      parametres: "La plateforme est revenue sans code d'autorisation.",
      etsy: "Etsy a refusé l'échange. Les deux causes de loin les plus fréquentes : l'application n'est pas encore validée, ou l'URL de retour déclarée ne correspond pas exactement à celle affichée ci-dessous.",
      ebay: "eBay a refusé l'échange. Vérifiez le RuName et l'environnement (production ou bac à sable).",
    };
    return {
      ok: false,
      titre: "Connexion refusée",
      // Le détail vient du serveur et nomme la cause réelle. Le texte
      // générique — une liste d'hypothèses — ne sert plus que lorsque la
      // plateforme n'a rien dit.
      corps: detail || (corps[erreur ?? ""] ?? "La plateforme a refusé la connexion."),
    };
  });

  if (!msg) return null;
  return (
    <div
      className={`banner ${msg.ok ? "banner--info" : "banner--warn"}`}
      style={{ marginTop: 0 }}
    >
      <span className="banner__t">{msg.titre}</span>
      <span className="banner__b">{msg.corps}</span>
    </div>
  );
}

/**
 * Formulaire de connexion Etsy.
 *
 * Une seule voie : Etsy impose PKCE et n'accepte pas qu'on colle un jeton
 * obtenu ailleurs, contrairement à eBay. Le secret partagé n'est pas demandé
 * — avec PKCE il ne sert à rien, et réclamer un secret inutilisé pousse à le
 * sortir de son coffre pour rien.
 */
function ConnectEtsy() {
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [sharedSecret, setSharedSecret] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const retour =
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/api/engine/accounts/etsy/callback`;

  if (!open) {
    return (
      <button
        className="btn btn--wide"
        style={{ marginTop: 9 }}
        onClick={() => setOpen(true)}
      >
        <Icon name="plug" />
        Relier une boutique Etsy
      </button>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ url: string }>("/engine/accounts/etsy/start", {
        clientId,
        sharedSecret,
        displayName,
      });
      window.location.href = r.url;
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Connexion impossible");
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ marginTop: 9 }} onSubmit={submit}>
      <h2 className="sec" style={{ marginTop: 0 }}>
        Relier Etsy
      </h2>

      <div className="banner banner--warn" style={{ marginTop: 0 }}>
        <span className="banner__t">Deux conditions avant que cela marche</span>
        <span className="banner__b">
          L'URL de retour ci-dessous doit être déclarée <b>à l'identique</b>{" "}
          dans les réglages de l'app — une barre oblique en trop suffit à
          faire échouer la connexion. Et si la page d'autorisation d'Etsy ne
          s'affiche pas, c'est que l'application attend encore sa validation :
          tant qu'elle est « Pending », Etsy bloque tout le parcours.
        </span>
      </div>

      <div className="field">
        <label>URL de retour à déclarer chez Etsy</label>
        <input className="input" readOnly value={retour} onFocus={(e) => e.target.select()} />
        <span className="muted">
          À coller dans « Callback URLs » sur la page de votre application.
        </span>
      </div>

      {err && <div className="login__err">{err}</div>}

      <div className="field">
        <label htmlFor="tk">Keystring</label>
        <input
          id="tk"
          className="input"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="ex. 1aa2bb33c44d55eeeeee6fff"
          required
        />
        <span className="muted">
          Portail développeur Etsy → Your Apps → votre application.
        </span>
      </div>

      <div className="field">
        <label htmlFor="ts">Secret partagé (shared secret)</label>
        <input
          id="ts"
          className="input"
          type="password"
          value={sharedSecret}
          onChange={(e) => setSharedSecret(e.target.value)}
          placeholder="a1b2c3d4e5"
          required
        />
        <span className="muted">
          Affiché sous « See API Key Details », à côté de la keystring. Etsy
          l'exige sur chaque appel depuis février 2026 — sans lui,
          l'autorisation réussit puis toutes les lectures échouent.
        </span>
      </div>

      <div className="field">
        <label htmlFor="tn">Nom affiché (facultatif)</label>
        <input
          id="tn"
          className="input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="repris du nom de la boutique si vide"
        />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? "Redirection…" : "Continuer sur Etsy"}
        </button>
        <button
          className="btn btn--ghost"
          type="button"
          onClick={() => setOpen(false)}
        >
          Annuler
        </button>
      </div>

      <p className="muted" style={{ margin: "10px 0 0", lineHeight: 1.55 }}>
        Etsy demandera l'accès à vos annonces et à vos commandes. Le jeton
        obtenu vit 90 jours et se renouvelle tout seul à chaque
        synchronisation ; il n'expire que si la boutique reste injoignable
        trois mois d'affilée.
      </p>
    </form>
  );
}


/* ------------------------------------------------------------------ */
/* Catalogue des commandes                                             */
/* ------------------------------------------------------------------ */

interface CommandeVue {
  id: string;
  libelle: string;
  ecrit: boolean;
  portee: "multi" | "unique";
  etat: "possible" | "impossible" | "bloquee";
  manque?: string[];
  raison?: string;
}

interface BoutiqueVue {
  id: string;
  plateforme: string;
  nom: string;
  statut: string;
  ventesEntrantes: string;
  commandes: CommandeVue[];
}

const VENTES_ENTRANTES: Record<string, string> = {
  webhook: "poussées en direct",
  both: "poussées en direct, avec relevé de secours",
  poll: "relevées toutes les 2 minutes",
  manual: "à saisir à la main",
  none: "aucune remontée",
};

/**
 * Ce que chaque boutique sait faire — et ce qui manque quand elle ne peut pas.
 *
 * Une capacité absente n'est pas une fatalité : le plus souvent c'est une
 * configuration qui manque dans le compte marchand. Griser un bouton sans le
 * dire oblige à deviner ; nommer la valeur absente et l'endroit où la créer
 * transforme un mur en tâche. C'est toute la différence entre les deux états
 * « impossible » et « bloquée ».
 */
function Catalogue() {
  const { data } = useQuery({
    queryKey: ["catalogue"],
    queryFn: () => api.get<{ boutiques: BoutiqueVue[] }>("/engine/catalogue"),
  });

  if (!data || data.boutiques.length === 0) return null;

  return (
    <>
      <h2 className="sec">Ce que chaque boutique sait faire</h2>
      <div style={{ display: "grid", gap: 9 }}>
        {data.boutiques.map((b) => (
          <div className="card" key={b.id}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span className="row__t">{b.nom}</span>
              <span className="muted">
                {b.plateforme} · ventes {VENTES_ENTRANTES[b.ventesEntrantes] ?? b.ventesEntrantes}
              </span>
            </div>

            <div style={{ display: "grid", gap: 7, marginTop: 10 }}>
              {b.commandes.map((cmd) => (
                <div key={cmd.id}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      className={
                        cmd.etat === "possible"
                          ? "pill pill--ok"
                          : cmd.etat === "bloquee"
                            ? "pill pill--warn"
                            : "pill pill--mute"
                      }
                    >
                      {cmd.etat === "possible"
                        ? "oui"
                        : cmd.etat === "bloquee"
                          ? "à configurer"
                          : "non"}
                    </span>
                    <span className="row__t" style={{ fontWeight: 500 }}>
                      {cmd.libelle}
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {cmd.ecrit ? "écriture" : "lecture"}
                    </span>
                  </div>

                  {cmd.etat === "bloquee" && (
                    <div
                      className="row__s"
                      style={{ whiteSpace: "normal", lineHeight: 1.45, marginTop: 3 }}
                    >
                      Manque : {cmd.manque?.join(", ")}. {cmd.raison}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}


/* ------------------------------------------------------------------ */
/* Réglages du compte marchand                                         */
/* ------------------------------------------------------------------ */

interface Reglage {
  key: string;
  label: string;
  aide: string;
  options: Array<{ id: string; label: string; detail?: string }>;
}

/**
 * Choisir ses politiques et profils dans une liste, au lieu de recopier des
 * identifiants.
 *
 * eBay en demande quatre, Etsy deux — des nombres à rallonge sans
 * signification. Une faute de frappe ne se voit qu'à la première publication
 * ratée, des jours plus tard, avec un message qui ne dit pas laquelle des
 * valeurs est fausse. La plateforme sait les lister : autant les lire.
 *
 * Une liste vide n'est pas une erreur — c'est le cas normal tant que l'objet
 * n'existe pas côté marchand. D'où le texte d'aide, qui dit où aller le créer
 * plutôt que de laisser un menu vide sans explication.
 */
function Reglages({
  accountId,
  onFerme,
}: {
  accountId: string;
  onFerme: () => void;
}) {
  const qc = useQueryClient();
  const [choix, setChoix] = useState<Record<string, string>>({});

  const { data, isLoading, error } = useQuery({
    queryKey: ["reglages", accountId],
    queryFn: () =>
      api.get<{
        reglages: Reglage[];
        choisis?: Record<string, string>;
        message?: string;
      }>(`/engine/accounts/${accountId}/reglages`),
    retry: false,
  });

  const enregistrer = useMutation({
    mutationFn: (valeurs: Record<string, string>) =>
      api.post(`/engine/accounts/${accountId}/reglages`, valeurs),
    onSuccess: async () => {
      toast("Réglages enregistrés");
      await qc.invalidateQueries({ queryKey: ["catalogue"] });
      await qc.invalidateQueries({ queryKey: ["reglages", accountId] });
    },
    onError: (e: unknown) => toast(e instanceof Error ? e.message : "Échec"),
  });

  if (isLoading) {
    return (
      <div className="card" style={{ marginTop: 9 }}>
        <PalmLoader compact label="Lecture de vos profils chez la plateforme…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="banner banner--warn" style={{ marginTop: 9 }}>
        <span className="banner__t">Lecture impossible</span>
        <span className="banner__b">
          {error instanceof Error ? error.message : "La plateforme n'a pas répondu."}
        </span>
      </div>
    );
  }

  const valeurs = { ...(data?.choisis ?? {}), ...choix };

  return (
    <div className="card" style={{ marginTop: 9 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="row__t">Réglages exigés pour publier</span>
        <button className="btn btn--small btn--ghost" onClick={onFerme}>
          Fermer
        </button>
      </div>

      {data?.message && (
        <p className="muted" style={{ marginTop: 10, lineHeight: 1.5 }}>
          {data.message}
        </p>
      )}

      {(data?.reglages ?? []).map((r) => (
        <div className="field" key={r.key}>
          <label htmlFor={`r-${r.key}`}>{r.label}</label>
          {r.options.length === 0 ? (
            <div className="row__s" style={{ whiteSpace: "normal", lineHeight: 1.45 }}>
              Rien à proposer — {r.aide}
              {/* L'adresse d'expédition d'eBay est le seul objet qui n'existe
                  nulle part dans son interface : elle ne se crée que par
                  l'API. Sans ce bouton, un vendeur qui ne code pas ne peut
                  tout simplement pas publier. */}
              {r.key === "merchantLocationKey" && (
                <CreerAdresse accountId={accountId} />
              )}
            </div>
          ) : (
            <select
              id={`r-${r.key}`}
              className="input"
              value={valeurs[r.key] ?? ""}
              onChange={(e) => setChoix({ ...choix, [r.key]: e.target.value })}
            >
              <option value="">— à choisir —</option>
              {r.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                  {o.detail ? ` — ${o.detail}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      ))}

      {(data?.reglages ?? []).some((r) => r.options.length > 0) && (
        <button
          className="btn btn--primary btn--wide"
          style={{ marginTop: 4 }}
          disabled={enregistrer.isPending || Object.keys(choix).length === 0}
          onClick={() => enregistrer.mutate(valeurs)}
        >
          Enregistrer
        </button>
      )}
    </div>
  );
}


/**
 * Crée l'adresse d'expédition d'eBay.
 *
 * C'est la seule écriture que l'outil se permette dans un compte marchand, et
 * elle est derrière un geste explicite. L'objet est technique — l'entrepôt
 * d'où part le colis — et n'engage ni prix, ni délai, ni condition de retour.
 * eBay n'exige qu'un pays et un code postal.
 */
function CreerAdresse({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const [ouvert, setOuvert] = useState(false);
  const [nom, setNom] = useState("Entrepôt principal");
  const [codePostal, setCodePostal] = useState("");
  const [ville, setVille] = useState("");

  const creer = useMutation({
    mutationFn: () =>
      api.post(`/engine/accounts/${accountId}/ebay/adresse`, {
        nom,
        pays: "FR",
        codePostal,
        ville,
      }),
    onSuccess: async () => {
      toast("Adresse d'expédition créée");
      await qc.invalidateQueries({ queryKey: ["reglages", accountId] });
      await qc.invalidateQueries({ queryKey: ["catalogue"] });
      setOuvert(false);
    },
    onError: (e: unknown) =>
      toast(e instanceof Error ? e.message : "Création impossible"),
  });

  if (!ouvert) {
    return (
      <button
        className="btn btn--small"
        style={{ marginTop: 8 }}
        onClick={() => setOuvert(true)}
      >
        Créer l'adresse
      </button>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div className="field">
        <label htmlFor="adr-nom">Nom de l'entrepôt</label>
        <input
          id="adr-nom"
          className="input"
          value={nom}
          onChange={(e) => setNom(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="adr-cp">Code postal</label>
        <input
          id="adr-cp"
          className="input"
          value={codePostal}
          onChange={(e) => setCodePostal(e.target.value)}
          placeholder="83500"
        />
      </div>
      <div className="field">
        <label htmlFor="adr-ville">Ville</label>
        <input
          id="adr-ville"
          className="input"
          value={ville}
          onChange={(e) => setVille(e.target.value)}
          placeholder="La Seyne-sur-Mer"
        />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="btn btn--primary btn--small"
          disabled={!codePostal || creer.isPending}
          onClick={() => creer.mutate()}
        >
          Créer chez eBay
        </button>
        <button className="btn btn--small btn--ghost" onClick={() => setOuvert(false)}>
          Annuler
        </button>
      </div>
    </div>
  );
}
