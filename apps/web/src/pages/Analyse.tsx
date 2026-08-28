import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, money } from "../lib/api.js";
import {
  confidenceLabel,
  days,
  describeFailure,
  elapsed,
  forgetJob,
  isTerminal,
  percent,
  readJob,
  rememberedJobs,
  rememberJob,
  startJob,
  SKILLS,
  SKILL_LABELS,
  type AnalysableProduct,
  type AnomalyReport,
  type MarketResearch,
  type Observation,
  type PanelHealth,
  type Provenance,
  type PriceAdvice,
  type ProductAnalysis,
  type RememberedJob,
  type RestockAdvice,
  type RunEnvelope,
  type SkillKey,
  type SupplierSearch,
  type VolumeMarche,
  domaine,
  estLienExterne,
  observeeLe,
  sitesConsultes,
  SKILLS_EXTERIEURES,
} from "../lib/ai.js";
import { Empty } from "../components/Empty.js";
import { Icon } from "../components/Icon.js";
import { PalmLoader } from "../components/PalmLoader.js";
import { Rempart } from "../components/Rempart.js";
import { toast } from "../components/Toast.js";

/**
 * Analyse — le panel d'IA au travail.
 *
 * RIEN NE SE PASSE DANS CETTE PAGE. Un clic empile un travail sur Cloudflare et
 * rend la main aussitôt ; la page ne fait ensuite que demander « c'est fini ? »
 * toutes les quelques secondes. On peut fermer l'application, verrouiller le
 * téléphone, revenir le lendemain : le résultat attend.
 *
 * Ce détour n'est pas de la sophistication gratuite. Une analyse demande sept à
 * dix-huit secondes, et sur iPhone verrouiller l'écran suffit à suspendre la
 * page — un appel direct mourrait avec elle, sans rien laisser.
 *
 * DEUX RÈGLES D'AFFICHAGE gouvernent le reste :
 *
 * 1. LE CALCULÉ AVANT L'INTERPRÉTÉ. Les mesures — ventes, couverture, marge,
 *    prix — sortent d'un calcul en TypeScript et sont exactes. La conclusion
 *    sort d'un modèle et peut se tromper. Les mélanger dans un même bloc
 *    donnerait à la seconde la crédibilité des premières.
 *
 * 2. CE QU'ON NE SAIT PAS RESTE ÉCRIT. Un prix d'achat manquant, une
 *    commission inconnue : la page le dit à chaque fois. C'est ce qui empêche
 *    une marge partielle d'être lue comme une marge.
 */
export function Analyse() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [jobs, setJobs] = useState<RememberedJob[]>(() => rememberedJobs());

  const { data: health } = useQuery({
    queryKey: ["ai-health"],
    queryFn: () => api.get<PanelHealth>("/ai/health"),
    retry: false,
  });

  const { data, isLoading } = useQuery({
    queryKey: ["ai-products"],
    queryFn: () => api.get<{ produits: AnalysableProduct[] }>("/ai/products"),
  });

  const lancer = useMutation({
    mutationFn: async (v: { skill: SkillKey; produit: AnalysableProduct; refaire?: boolean }) => {
      const { jobId } = await startJob(
        SKILLS[v.skill],
        { productId: v.produit.productId },
        v.refaire ?? false,
      );
      return {
        jobId,
        skill: v.skill,
        productId: v.produit.productId,
        productTitle: v.produit.title,
        startedAt: Date.now(),
      };
    },
    onSuccess: (job) => {
      setJobs(rememberJob(job));
      toast("Analyse lancée — vous pouvez fermer l'application");
    },
    onError: (error) => toast(describeFailure(error).titre),
  });

  const oublier = (jobId: string) => setJobs(forgetJob(jobId));

  if (isLoading || !data) return <PalmLoader label="Chargement des analyses…" />;

  const produit = data.produits.find((p) => p.productId === selected) ?? null;
  const enCours = jobs.length > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analyse</h1>
          <p>Le panel raisonne sur vos chiffres, jamais sur ceux du navigateur.</p>
        </div>
      </div>

      {health && <Budget health={health} />}

      {enCours && (
        <>
          <h2 className="sec">
            Analyses <span>{jobs.length}</span>
          </h2>
          {jobs.map((job) => (
            <Travail
              key={job.jobId}
              job={job}
              onFini={() => {
                // La consommation a bougé : le bandeau de budget doit suivre.
                void qc.invalidateQueries({ queryKey: ["ai-health"] });
              }}
              onEcarter={() => oublier(job.jobId)}
              onRefaire={() => {
                const cible = data.produits.find((p) => p.productId === job.productId);
                if (!cible) return;
                oublier(job.jobId);
                lancer.mutate({ skill: job.skill, produit: cible, refaire: true });
              }}
            />
          ))}
        </>
      )}

      {data.produits.length === 0 ? (
        <Empty icon="sparkle" title="Aucun produit à analyser">
          Le panel travaille sur les produits du catalogue central, pas sur les
          annonces isolées. Une annonce synchronisée rejoint son produit par son
          SKU ; sans produit correspondant, elle reste sans rattachement.
        </Empty>
      ) : (
        <>
          <h2 className="sec">
            Produit <span>{data.produits.length}</span>
          </h2>
          <div className="rows">
            {data.produits.map((p) => (
              <button
                key={p.productId}
                className={p.productId === selected ? "row row--low" : "row"}
                style={{ textAlign: "left", width: "100%", cursor: "pointer" }}
                onClick={() => setSelected(p.productId)}
              >
                <span className="mono-badge">{p.sku.slice(0, 2).toUpperCase()}</span>
                <div className="row__main">
                  <div className="row__t">{p.title}</div>
                  <div className="row__s">
                    {p.sku} ·{" "}
                    {p.canaux > 0
                      ? `${p.canaux} canal${p.canaux > 1 ? "ux" : ""}`
                      : "aucune annonce reliée"}
                  </div>
                </div>
                <div className="row__end">
                  <span className="amount">{money(p.referencePrice)}</span>
                  <span className="muted">{p.onHand} en stock</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {produit && (
        <>
          <h2 className="sec">Que faire de « {produit.title} » ?</h2>

          {produit.costPrice === null && (
            <div className="banner banner--warn" style={{ marginBottom: 10 }}>
              <Icon name="lock" />
              <div>
                <div className="banner__t">Prix d'achat inconnu</div>
                <div className="banner__b">
                  Sans lui, ni la marge ni le prix plancher ne peuvent être
                  calculés. Le panel le signalera plutôt que de l'estimer.
                </div>
              </div>
            </div>
          )}

          <div className="grid g2">
            {(Object.keys(SKILL_LABELS) as SkillKey[]).map((key) => (
              <button
                key={key}
                className="btn"
                disabled={lancer.isPending}
                onClick={() => lancer.mutate({ skill: key, produit })}
                title={SKILL_LABELS[key].detail}
              >
                {SKILL_LABELS[key].titre}
              </button>
            ))}
          </div>

          {health && !health.sourcesDeRecherche.some((s) => s.disponible) && (
            <div className="banner banner--info" style={{ marginTop: 10 }}>
              <Icon name="plug" />
              <div>
                <div className="banner__t">
                  « {SKILL_LABELS[SKILLS_EXTERIEURES[0] as SkillKey].titre} » et «{" "}
                  {SKILL_LABELS[SKILLS_EXTERIEURES[1] as SkillKey].titre} » ne verront que vos
                  données
                </div>
                <div className="banner__b">
                  Aucun moteur de recherche n'est branché, ou son quota mensuel
                  est atteint. Ces deux analyses fonctionnent quand même, mais se
                  limitent à vos propres annonces. La clé Tavily se crée sur
                  app.tavily.com, sans carte bancaire.
                </div>
              </div>
            </div>
          )}

          <p className="muted" style={{ marginTop: 10, lineHeight: 1.55 }}>
            Chaque analyse part en arrière-plan. Vous pouvez fermer
            l'application : le résultat vous attendra ici.
          </p>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Un travail, de la file d'attente au résultat                        */
/* ------------------------------------------------------------------ */

/**
 * Interroge le serveur jusqu'à ce que le travail soit classé.
 *
 * La cadence part de deux secondes puis passe à cinq : une analyse tient
 * rarement sous dix secondes, et continuer à demander toutes les deux secondes
 * pendant une minute ne ferait que consommer des requêtes pour rien.
 *
 * L'intervalle s'annule dès l'état terminal — sans quoi la page continuerait à
 * interroger indéfiniment un travail déjà fini.
 */
function Travail({
  job,
  onFini,
  onEcarter,
  onRefaire,
}: {
  job: RememberedJob;
  onFini: () => void;
  onEcarter: () => void;
  onRefaire: () => void;
}) {
  const { data, isError, error } = useQuery({
    queryKey: ["ai-job", job.jobId],
    queryFn: () => readJob<unknown>(job.jobId),
    refetchInterval: (query) => {
      const etat = query.state.data;
      if (etat && isTerminal(etat.status)) return false;
      return Date.now() - job.startedAt < 12_000 ? 2_000 : 5_000;
    },
    // Reprend l'interrogation au retour dans l'application, précisément le cas
    // pour lequel tout ce mécanisme existe.
    refetchOnWindowFocus: true,
    retry: 1,
  });

  // `useEffect` et non un `onSuccess` : la requête peut se résoudre depuis le
  // cache au remontage, et le budget doit être rafraîchi dans ce cas aussi.
  const fini = data ? isTerminal(data.status) : false;
  useEffect(() => {
    if (fini) onFini();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fini]);

  const titre = SKILL_LABELS[job.skill].titre;

  if (isError) {
    return (
      <Carte titre={titre} produit={job.productTitle} onEcarter={onEcarter}>
        <Echec error={error} />
      </Carte>
    );
  }

  if (!data || !fini) {
    return (
      <Carte titre={titre} produit={job.productTitle} onEcarter={onEcarter}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="pill pill--mute">
            {data?.status === "running" ? "en cours" : "en attente"}
          </span>
          <span className="muted" style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>
            depuis {elapsed(job.startedAt)}
          </span>
        </div>
        <p className="muted" style={{ margin: "10px 0 0", lineHeight: 1.55 }}>
          Le travail tourne sur Cloudflare, pas dans cette page. Vous pouvez la
          fermer.
        </p>
      </Carte>
    );
  }

  if (data.status === "failed" || !data.result) {
    return (
      <Carte titre={titre} produit={job.productTitle} onEcarter={onEcarter}>
        <Echec error={data.error ?? "echec_analyse"} />
        <button className="btn btn--ghost btn--small" style={{ marginTop: 10 }} onClick={onRefaire}>
          <Icon name="refresh" />
          Relancer
        </button>
      </Carte>
    );
  }

  return (
    <Carte titre={titre} produit={job.productTitle} onEcarter={onEcarter}>
      {/* Le rempart isole CE résultat : s'il ne s'affiche pas, les autres et
          le reste de l'écran continuent de fonctionner. Sans lui, une seule
          analyse mal formée laissait une page entièrement noire. */}
      <Rempart
        recours={
          <button
            className="btn btn--ghost btn--small"
            style={{ marginTop: 10 }}
            onClick={onRefaire}
          >
            <Icon name="refresh" />
            Relancer l'analyse
          </button>
        }
      >
        <Provenance envelope={data.result} onRefaire={onRefaire} />
        <Resultat skill={job.skill} envelope={data.result} />
        {!data.result.cached && <Retour runId={data.result.runId} />}
      </Rempart>
    </Carte>
  );
}

function Carte({
  titre,
  produit,
  onEcarter,
  children,
}: {
  titre: string;
  produit: string;
  onEcarter: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <span className="row__t">{titre}</span>
        <span className="muted" style={{ fontSize: 12 }}>
          {produit}
        </span>
        <button
          className="btn btn--ghost btn--small"
          style={{ marginLeft: "auto" }}
          onClick={onEcarter}
          aria-label="Écarter cette analyse"
        >
          Écarter
        </button>
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

/**
 * Ce qu'il reste d'allocation gratuite aujourd'hui.
 *
 * Affiché en permanence et non caché dans les réglages : c'est la ressource
 * qui décide de ce que le panel peut encore faire dans la journée. La voir
 * baisser explique pourquoi une analyse bascule sur un modèle plus léger en
 * fin d'après-midi.
 */
function Budget({ health }: { health: PanelHealth }) {
  const { consommes, alloues, restants } = health.neurones;
  const part = Math.min(100, Math.round((consommes / alloues) * 100));
  const configures = health.fournisseurs.filter((f) => f.configure);

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="stat__l">Allocation gratuite du jour</span>
        <span
          className={
            part >= 90 ? "pill pill--stop" : part >= 60 ? "pill pill--warn" : "pill pill--ok"
          }
        >
          {Math.round(restants).toLocaleString("fr-FR")} restants
        </span>
      </div>

      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "var(--card-3)",
          margin: "10px 0 8px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${part}%`,
            height: "100%",
            background:
              part >= 90 ? "var(--stop)" : part >= 60 ? "var(--warn)" : "var(--accent)",
          }}
        />
      </div>

      <span className="stat__d">
        {Math.round(consommes).toLocaleString("fr-FR")} /{" "}
        {alloues.toLocaleString("fr-FR")} neurones · remise à zéro à minuit UTC ·{" "}
        {configures.length} fournisseur{configures.length > 1 ? "s" : ""} configuré
        {configures.length > 1 ? "s" : ""}
      </span>
    </div>
  );
}

function Echec({ error }: { error: unknown }) {
  const { titre, detail } = describeFailure(error);
  return (
    <div className="banner banner--stop" style={{ margin: 0 }}>
      <Icon name="clock" />
      <div>
        <div className="banner__t">{titre}</div>
        <div className="banner__b">{detail}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Résultats                                                           */
/* ------------------------------------------------------------------ */

function Resultat({ skill, envelope }: { skill: SkillKey; envelope: RunEnvelope<unknown> }) {
  if (skill === "analyse") return <AnalysisView data={envelope.result as ProductAnalysis} />;
  if (skill === "prix") return <PriceView data={envelope.result as PriceAdvice} />;
  if (skill === "reappro") return <RestockView data={envelope.result as RestockAdvice} />;
  if (skill === "marche") return <MarketView data={envelope.result as MarketResearch} />;
  if (skill === "fournisseurs") return <SupplierView data={envelope.result as SupplierSearch} />;
  return <AnomalyView data={envelope.result as AnomalyReport} />;
}

/**
 * D'où vient cette réponse.
 *
 * Le modèle est nommé parce qu'il change : le routeur choisit selon ce qu'il
 * reste de budget, et deux analyses du même produit à une heure d'écart
 * peuvent venir de deux modèles différents. Sans cette ligne, un changement de
 * ton dans les conclusions serait inexplicable.
 */
function Provenance({
  envelope,
  onRefaire,
}: {
  envelope: RunEnvelope<unknown>;
  onRefaire: () => void;
}) {
  return (
    <div className="card card--flush" style={{ marginBottom: 9 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          fontSize: 11.5,
          color: "var(--muted)",
        }}
      >
        {envelope.cached ? (
          <span className="pill pill--mute">en cache</span>
        ) : (
          <span className="pill pill--ok">{Math.round(envelope.neurons)} neurones</span>
        )}
        <span style={{ fontFamily: "var(--mono)" }}>
          {envelope.cached
            ? "réponse déjà calculée, aucun modèle appelé"
            : `${envelope.provider ?? "—"} · ${envelope.model ?? "aucun modèle"}`}
        </span>
        <button className="btn btn--ghost btn--small" style={{ marginLeft: "auto" }} onClick={onRefaire}>
          <Icon name="refresh" />
          Recalculer
        </button>
      </div>

      {envelope.trace.length > 1 && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 11.5 }}>
            {envelope.trace.length} modèles essayés
          </summary>
          <ul
            style={{
              margin: "6px 0 0",
              paddingLeft: 18,
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              color: "var(--muted)",
              lineHeight: 1.6,
            }}
          >
            {envelope.trace.map((ligne, i) => (
              <li key={`${i}-${ligne}`}>{ligne}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Bloc de mesures : ce qui est calculé, donc exact. */
function Measured({ children }: { children: React.ReactNode }) {
  return (
    <>
      <h3 className="sec" style={{ fontSize: 12 }}>
        Mesuré
      </h3>
      <div className="grid g2">{children}</div>
    </>
  );
}

function Stat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "up" | "down" | "warn";
}) {
  return (
    <div className="card">
      <span className="stat__l">{label}</span>
      <span className="stat__v">{value}</span>
      {detail && <span className={tone ? `stat__d stat__d--${tone}` : "stat__d"}>{detail}</span>}
    </div>
  );
}

/**
 * Bloc d'interprétation : ce que le modèle en dit.
 *
 * Titré séparément et accompagné de sa confiance. La séparation visuelle est
 * la seule chose qui empêche « ce produit est sain » d'être lu avec la même
 * assurance que « 3 ventes par jour ».
 */
function Interpreted({
  confidence,
  children,
}: {
  confidence: number;
  children: React.ReactNode;
}) {
  const { texte, classe } = confidenceLabel(confidence);
  return (
    <>
      <h3 className="sec" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
        Interprété par le modèle
        <span className={classe}>{texte}</span>
      </h3>
      <div className="card">{children}</div>
    </>
  );
}

function Unknowns({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="banner banner--info" style={{ marginTop: 9 }}>
      <Icon name="lock" />
      <div>
        <div className="banner__t">Données manquantes</div>
        <div className="banner__b">
          {items.join(", ")}. Ces éléments restent inconnus : ils n'ont pas été
          estimés, et les chiffres qui en dépendent ne sont pas affichés.
        </div>
      </div>
    </div>
  );
}

function List({ titre, items }: { titre: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="row__t" style={{ marginBottom: 6 }}>
        {titre}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
        {items.map((item) => (
          <li key={item} className="row__s" style={{ whiteSpace: "normal" }}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------- Vues par skill ---------------------------- */

function AnalysisView({ data }: { data: ProductAnalysis }) {
  const { ventes, couverture, tendance, prix, marge } = data.mesures;

  return (
    <>
      <Measured>
        <Stat
          label="Rythme de vente"
          value={`${ventes.perDay.toFixed(1)} /j`}
          detail={`${ventes.totalUnits} unités sur ${ventes.days} jours`}
        />
        <Stat
          label="Couverture de stock"
          value={days(couverture.days)}
          detail={`${couverture.available} disponibles`}
          {...(couverture.low ? { tone: "warn" as const } : {})}
        />
        <Stat
          label="Tendance"
          value={percent(tendance.change)}
          detail="seconde moitié vs première"
          {...(tendance.change === null
            ? {}
            : { tone: tendance.change >= 0 ? ("up" as const) : ("down" as const) })}
        />
        <Stat
          label="Marge au prix médian"
          value={
            marge?.marginRate === null || marge?.marginRate === undefined
              ? "—"
              : percent(marge.marginRate)
          }
          detail={
            prix ? `prix médian ${money(prix.median)} sur ${prix.count} canaux` : "aucune annonce"
          }
        />
      </Measured>

      <Unknowns items={data.inconnues} />

      <Interpreted confidence={data.analyse.confidence}>
        <p style={{ margin: 0, lineHeight: 1.6 }}>{data.analyse.conclusion}</p>
        <List titre="Forces" items={data.analyse.forces} />
        <List titre="Risques" items={data.analyse.risques} />
        <List titre="À envisager" items={data.analyse.actions} />
        <p className="muted" style={{ marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>
          Ces suggestions ne sont pas appliquées. Le panel recommande ; les
          modifications de prix et de stock passent par les écrans habituels.
        </p>
      </Interpreted>
    </>
  );
}

function PriceView({ data }: { data: PriceAdvice }) {
  const { recommandation, actuel, plancherCentimes } = data;

  return (
    <>
      <Measured>
        <Stat
          label="Prix pratiqué"
          value={actuel.prix ? money(actuel.prix.median) : "—"}
          detail={
            actuel.prix
              ? `de ${money(actuel.prix.min)} à ${money(actuel.prix.max)}`
              : "aucune annonce reliée"
          }
        />
        <Stat
          label="Prix plancher"
          value={plancherCentimes === null ? "—" : money(plancherCentimes)}
          detail={
            plancherCentimes === null
              ? "incalculable sans commission"
              : "en dessous, la marge visée n'est plus atteinte"
          }
        />
      </Measured>

      <Unknowns items={data.inconnues} />

      {recommandation.ajusteAuPlancher && (
        <div className="banner banner--warn" style={{ marginTop: 9 }}>
          <Icon name="lock" />
          <div>
            <div className="banner__t">Proposition relevée au plancher</div>
            <div className="banner__b">
              Le modèle proposait un prix qui aurait détruit la marge visée. Le
              calcul a repris la main : c'est le seul endroit du panel où
              l'arithmétique contredit le modèle, et c'est volontaire.
            </div>
          </div>
        </div>
      )}

      <Interpreted confidence={recommandation.confidence}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <span className="stat__v">
            {recommandation.prixCentimes === null ? "—" : money(recommandation.prixCentimes)}
          </span>
          <span
            className={
              recommandation.direction === "maintenir"
                ? "pill pill--mute"
                : recommandation.direction === "monter"
                  ? "pill pill--ok"
                  : "pill pill--warn"
            }
          >
            {recommandation.direction}
          </span>
          {recommandation.ecartAuPrixActuel != null && (
            <span className="muted">{percent(recommandation.ecartAuPrixActuel)} vs actuel</span>
          )}
        </div>
        <p style={{ marginTop: 12, marginBottom: 0, lineHeight: 1.6 }}>
          {recommandation.justification}
        </p>
        <p className="muted" style={{ marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>
          Aucun prix n'a été modifié. Le panel n'écrit jamais chez une
          plateforme — cela reste le rôle des écrans de stock et de boutique.
        </p>
      </Interpreted>
    </>
  );
}

const URGENCE: Record<
  RestockAdvice["recommandation"]["urgence"],
  { texte: string; classe: string }
> = {
  immediat: { texte: "à commander maintenant", classe: "pill pill--stop" },
  bientot: { texte: "à commander bientôt", classe: "pill pill--warn" },
  surveiller: { texte: "à surveiller", classe: "pill pill--mute" },
  aucune: { texte: "rien à faire", classe: "pill pill--ok" },
};

function RestockView({ data }: { data: RestockAdvice }) {
  const urgence = URGENCE[data.recommandation.urgence];

  return (
    <>
      <Measured>
        <Stat
          label="Quantité à commander"
          value={data.quantiteCalculee === null ? "—" : String(data.quantiteCalculee)}
          detail={
            data.quantiteCalculee === null
              ? "pas assez d'historique pour conclure"
              : "délai fournisseur + couverture visée"
          }
        />
        <Stat
          label="Avant rupture"
          value={days(data.jusquaRupture)}
          detail={`${data.mesures.ventes.perDay.toFixed(1)} unités par jour`}
          {...(data.mesures.couverture.low ? { tone: "warn" as const } : {})}
        />
      </Measured>

      <Interpreted confidence={data.recommandation.confidence}>
        <span className={urgence.classe}>{urgence.texte}</span>
        <p style={{ marginTop: 12, marginBottom: 0, lineHeight: 1.6 }}>
          {data.recommandation.justification}
        </p>
        <List titre="À vérifier avant de commander" items={data.recommandation.reserves} />
      </Interpreted>
    </>
  );
}

function AnomalyView({ data }: { data: AnomalyReport }) {
  const { rapport } = data;

  if (!rapport.usable) {
    return (
      <div className="banner banner--info" style={{ margin: 0 }}>
        <Icon name="clock" />
        <div>
          <div className="banner__t">Rien à conclure</div>
          <div className="banner__b">
            {rapport.note} Aucun modèle n'a été appelé : la statistique suffisait
            à répondre, et un appel inutile aurait consommé de l'allocation.
          </div>
        </div>
      </div>
    );
  }

  if (rapport.anomalies.length === 0) {
    return (
      <div className="banner banner--info" style={{ margin: 0 }}>
        <Icon name="clock" />
        <div>
          <div className="banner__t">Ventes régulières</div>
          <div className="banner__b">
            Aucun jour ne s'écarte de plus de deux écarts-types de la moyenne (
            {rapport.mean} unités par jour). Réponse obtenue sans appeler de
            modèle.
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <h3 className="sec" style={{ fontSize: 12 }}>
        Mesuré <span>{rapport.anomalies.length} jours hors norme</span>
      </h3>
      <div className="rows">
        {rapport.anomalies.map((a) => (
          <div className="row" key={a.date}>
            <span className="mono-badge">{a.direction === "haut" ? "▲" : "▼"}</span>
            <div className="row__main">
              <div className="row__t">{a.date}</div>
              <div className="row__s">
                {a.units} unités · moyenne {rapport.mean} · écart-type {rapport.stdDev}
              </div>
            </div>
            <div className="row__end">
              <span className="amount">{a.z > 0 ? `+${a.z}` : a.z} σ</span>
            </div>
          </div>
        ))}
      </div>

      {data.explication && (
        <Interpreted confidence={data.explication.confidence}>
          <p style={{ margin: 0, lineHeight: 1.6 }}>{data.explication.resume}</p>
          <List titre="Pistes à vérifier" items={data.explication.pistes} />
          <p className="muted" style={{ marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>
            Ce sont des hypothèses, pas des causes établies. Le modèle n'a vu
            que la série de ventes.
          </p>
        </Interpreted>
      )}
    </>
  );
}

/* ------------------------- Recherche extérieure ------------------------- */

/**
 * D'où viennent les preuves, et ce que la recherche a coûté.
 *
 * Affiché systématiquement, pas seulement en cas de problème : savoir que la
 * réponse tient sur nos seules données change complètement la façon de la
 * lire. La date des taux de change y figure parce qu'une conversion sans date
 * n'est pas vérifiable.
 */
function ProvenanceRecherche({ p }: { p: Provenance }) {
  return (
    <p
      className="muted"
      style={{ marginTop: 10, marginBottom: 0, lineHeight: 1.55, fontSize: 11.5 }}
    >
      Couches interrogées : {p.couches.length > 0 ? p.couches.join(", ") : "aucune"}.{" "}
      {p.rechercheWebUtilisee
        ? "Le quota de recherche web a été entamé."
        : "Aucune recherche web n'a été nécessaire."}
      {p.tauxPublicsDu && ` Taux de change BCE du ${p.tauxPublicsDu}.`}
      {p.cache && " Résultat servi depuis le cache."}
    </p>
  );
}

function Avertissements({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="banner banner--warn" style={{ marginTop: 9 }}>
      <Icon name="lock" />
      <div>
        <div className="banner__t">À savoir</div>
        <div className="banner__b">
          {items.map((a, i) => (
            <div key={`${i}-${a.slice(0, 24)}`} style={{ marginTop: i > 0 ? 6 : 0 }}>
              {a}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Une observation, avec de quoi la vérifier.
 *
 * Le prix converti et le prix affiché voisinent délibérément : sans le second,
 * rouvrir le lien ne permet pas de contrôler la conversion, et une conversion
 * invérifiable est un chiffre qu'il faut croire sur parole.
 *
 * Une preuve interne n'est pas un lien. Elle désigne notre propre annonce, et
 * la présenter comme une source extérieure fausserait la lecture.
 */
function LigneObservation({ o }: { o: Observation }) {
  const interne = o.source === "internal";
  const titre = o.titre ?? o.url;

  return (
    <div className="row">
      {/* La photo dit en un coup d'œil ce qu'aucun titre ne dit : si c'est
          bien le même objet. Deux annonces au même nom peuvent vendre deux
          produits différents — c'est précisément ce que le prix seul masque. */}
      {o.image ? (
        <img className="thumb" src={o.image} alt="" loading="lazy" />
      ) : (
        <span className="mono-badge">{interne ? "NS" : Math.round(o.fiabilite * 10)}</span>
      )}
      <div className="row__main">
        <div className="row__t">
          {estLienExterne(o.url) ? (
            <a href={o.url} target="_blank" rel="noreferrer noopener" style={{ color: "inherit" }}>
              {titre}
            </a>
          ) : (
            titre
          )}
        </div>
        <div className="row__s">
          {/* Le site d'abord : c'est lui qui dit si le prix est comparable.
              « 3,74 € sur etsy.com » et « 3,74 € sur amazon.fr » ne racontent
              pas la même chose, et un titre seul ne le révèle pas. */}
          <b style={{ fontWeight: 600, color: "var(--ink-2)" }}>
            {interne ? "votre boutique" : domaine(o.url)}
          </b>
          {" · "}
          {interne
            ? "votre annonce"
            : o.source === "page"
              ? "page produit"
              : "résultat de recherche"}
          {" · vu le "}
          {observeeLe(o.observeLe)}
        </div>
      </div>
      <div className="row__end">
        <span className="amount">{o.prixEur == null ? "—" : money(o.prixEur)}</span>
        {o.prixEur != null && o.devise && o.devise !== "EUR" && o.prixOrigine != null ? (
          <span className="muted">
            {(o.prixOrigine / 100).toFixed(2)} {o.devise}
          </span>
        ) : (
          o.prixEur === null && (
            <span className="muted">
              {/* Distinction utile : la page n'affichait pas de prix, ou elle
                  en affichait un dans une devise qu'on ne sait pas convertir.
                  Les confondre laisserait croire à une lacune du panel. */}
              {o.prixOrigine == null ? "pas de prix affiché" : "devise non convertie"}
            </span>
          )
        )}
        {o.ventes != null && (
          <span className="pill pill--ok" style={{ marginTop: 4 }}>
            {o.ventes.toLocaleString("fr-FR")} vendus
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Les sites d'où viennent les observations.
 *
 * Demandé, et à raison : une médiane ne veut rien dire tant qu'on ignore d'où
 * elle sort. Voir « leboncoin.fr » dans la liste explique immédiatement un
 * prix bas — c'est de l'occasion — là où le même chiffre sans provenance
 * ressemblerait à un concurrent agressif.
 */
function SitesConsultes({ observations }: { observations: Observation[] }) {
  const sites = sitesConsultes(observations);
  if (sites.length === 0) return null;

  return (
    <p
      className="muted"
      style={{ margin: "0 0 9px", lineHeight: 1.6, fontSize: 11.5, fontFamily: "var(--mono)" }}
    >
      Sites consultés : {sites.join(" · ")}
    </p>
  );
}

const POSITION: Record<MarketResearch["lecture"]["position"], string> = {
  "au-dessus": "pill pill--warn",
  "dans le marché": "pill pill--ok",
  "en dessous": "pill pill--warn",
  "indéterminée": "pill pill--mute",
};

/**
 * La synthèse, toujours la même forme.
 *
 * Demandée, et c'est un vrai besoin : un texte libre change de structure à
 * chaque exécution, et l'on doit le relire en entier pour y retrouver
 * l'essentiel. Ici la mise en page est FIXE — position, marché, volume,
 * lecture, réserves — et seul le contenu varie. On sait où regarder avant même
 * d'avoir lu.
 *
 * Les trois premiers blocs sont calculés, pas rédigés : ils ne peuvent pas
 * changer de ton selon l'humeur du modèle.
 */
function Synthese({ data }: { data: MarketResearch }) {
  const { marche, notre, lecture } = data;
  const volume = data.volume ?? VOLUME_ABSENT;
  const { texte, classe } = confidenceLabel(lecture.confidence);

  const ecart =
    notre.ecartAuMarche === null
      ? null
      : Math.abs(notre.ecartAuMarche) < 0.05
        ? "au niveau du marché"
        : `${percent(notre.ecartAuMarche)} ${notre.ecartAuMarche > 0 ? "au-dessus" : "en dessous"}`;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <span className="row__t">Synthèse</span>
        <span className={POSITION[lecture.position]}>{lecture.position}</span>
        <span className={classe} style={{ marginLeft: "auto" }}>
          {texte}
        </span>
      </div>

      <dl style={{ margin: 0, display: "grid", gap: 10 }}>
        <LigneSynthese titre="Votre prix">
          {notre.prixMedianEur === null ? "inconnu" : money(notre.prixMedianEur)}
          {ecart && ` — ${ecart}`}
        </LigneSynthese>

        <LigneSynthese titre="Le marché">
          {marche
            ? `${marche.count} offres, de ${money(marche.min)} à ${money(marche.max)}, médiane ${money(marche.median)}`
            : "pas assez d'offres comparables pour situer un prix"}
        </LigneSynthese>

        <LigneSynthese titre="Le volume">
          {volume.offresRenseignees === 0
            ? "aucune offre ne publie son nombre de ventes"
            : `${volume.totalVentes.toLocaleString("fr-FR")} ventes cumulées sur ${volume.offresRenseignees} offre${volume.offresRenseignees > 1 ? "s" : ""}` +
              (volume.meilleureVente
                ? ` — la plus vendue en est à ${volume.meilleureVente.ventes.toLocaleString("fr-FR")}${
                    volume.meilleureVente.prixEur != null
                      ? ` pour ${money(volume.meilleureVente.prixEur)}`
                      : ""
                  }`
                : "")}
        </LigneSynthese>

        <LigneSynthese titre="Lecture">{lecture.resume}</LigneSynthese>
      </dl>

      <ProvenanceRecherche p={data.provenance} />
    </div>
  );
}

function LigneSynthese({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <div>
      <dt
        className="stat__l"
        style={{ marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.04em" }}
      >
        {titre}
      </dt>
      <dd style={{ margin: 0, lineHeight: 1.55 }}>{children}</dd>
    </div>
  );
}

/**
 * Volume par défaut, pour un résultat produit avant que la colonne existe.
 *
 * Une analyse enregistrée reste consultable des heures après son calcul, et le
 * code qui l'affiche, lui, a pu changer entre-temps. Lire un champ sans
 * précaution suffit à faire disparaître l'écran — c'est exactement ce qui
 * s'est produit. Un résultat ancien doit se dégrader, jamais casser.
 */
const VOLUME_ABSENT: VolumeMarche = {
  offresRenseignees: 0,
  totalVentes: 0,
  meilleureVente: null,
};

function MarketView({ data }: { data: MarketResearch }) {
  const { marche, notre } = data;
  const volume = data.volume ?? VOLUME_ABSENT;

  return (
    <>
      <Measured>
        <Stat
          label="Prix du marché"
          value={marche ? money(marche.median) : "—"}
          detail={
            marche
              ? `de ${money(marche.min)} à ${money(marche.max)} sur ${marche.count} observations`
              : "pas assez de prix comparables"
          }
        />
        <Stat
          label="Ventes observées"
          value={
            volume.offresRenseignees === 0
              ? "—"
              : volume.totalVentes.toLocaleString("fr-FR")
          }
          detail={
            volume.offresRenseignees === 0
              ? "aucune offre ne publie ses ventes"
              : `sur ${volume.offresRenseignees} offre${volume.offresRenseignees > 1 ? "s" : ""} qui l'affichent`
          }
        />
        <Stat
          label="Notre prix"
          value={notre.prixMedianEur === null ? "—" : money(notre.prixMedianEur)}
          detail={
            notre.ecartAuMarche === null
              ? "écart incalculable"
              : `${percent(notre.ecartAuMarche)} par rapport au marché`
          }
          {...(notre.ecartAuMarche != null && Math.abs(notre.ecartAuMarche) > 0.15
            ? { tone: "warn" as const }
            : {})}
        />
      </Measured>

      <Avertissements items={data.avertissements} />

      {data.observations.length > 0 && (
        <>
          <h3 className="sec" style={{ fontSize: 12 }}>
            Observations <span>{data.observations.length}</span>
          </h3>
          <SitesConsultes observations={data.observations} />
          <div className="rows">
            {data.observations.map((o) => (
              <LigneObservation key={o.url} o={o} />
            ))}
          </div>
        </>
      )}

      <Synthese data={data} />
    </>
  );
}

function SupplierView({ data }: { data: SupplierSearch }) {
  return (
    <>
      <Measured>
        <Stat
          label="Prix unitaires trouvés"
          value={data.fourchette ? money(data.fourchette.median) : "—"}
          detail={
            data.fourchette
              ? `de ${money(data.fourchette.min)} à ${money(data.fourchette.max)}`
              : "aucun prix unitaire relevé"
          }
        />
        <Stat
          label="Notre prix d'achat"
          value={data.prixAchatActuel === null ? "—" : money(data.prixAchatActuel)}
          detail={data.prixAchatActuel === null ? "jamais saisi" : "actuellement payé"}
        />
      </Measured>

      <Avertissements items={data.avertissements} />

      {data.candidats.length === 0 ? (
        <div className="banner banner--info" style={{ marginTop: 9 }}>
          <Icon name="clock" />
          <div>
            <div className="banner__t">Aucune piste</div>
            <div className="banner__b">
              Rien n'a été trouvé pour « {data.requete} ». Une référence
              fabricant donne souvent de meilleurs résultats qu'un nom
              commercial.
            </div>
          </div>
        </div>
      ) : (
        <>
          <h3 className="sec" style={{ fontSize: 12 }}>
            Fournisseurs <span>{data.candidats.length}</span>
          </h3>
          <div className="rows">
            {data.candidats.map((c) => (
              <div className="row" key={c.url}>
                <span className="mono-badge">{Math.round(c.fiabilite * 10)}</span>
                <div className="row__main">
                  <div className="row__t">
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ color: "inherit" }}
                    >
                      {c.nom ?? c.url}
                    </a>
                  </div>
                  <div className="row__s" style={{ whiteSpace: "normal" }}>
                    <b style={{ fontWeight: 600, color: "var(--ink-2)" }}>{domaine(c.url)}</b>
                    {" · "}
                    {c.pourquoi} · vu le {observeeLe(c.observeLe)}
                  </div>
                </div>
                <div className="row__end">
                  <span className="amount">
                    {c.prixUnitaireEur === null ? "—" : money(c.prixUnitaireEur)}
                  </span>
                  <span className="muted">
                    {c.moq === null ? "minimum inconnu" : `min. ${c.moq}`}
                    {c.portConnu ? " · port connu" : " · port inconnu"}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <p className="muted" style={{ marginTop: 10, lineHeight: 1.55 }}>
            Quantité minimale et frais de port ne s'affichent que lorsque la
            page les indique. « Inconnu » veut dire inconnu, pas zéro : les
            supposer transformerait une piste en commande décidée sur une
            hypothèse.
          </p>
        </>
      )}

      <Interpreted confidence={data.lecture.confidence}>
        <p style={{ margin: 0, lineHeight: 1.6 }}>{data.lecture.resume}</p>
        <List titre="Réserves" items={data.lecture.reserves} />
        <ProvenanceRecherche p={data.provenance} />
      </Interpreted>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Retour                                                              */
/* ------------------------------------------------------------------ */

/**
 * Le seul signal de qualité qui ne vienne pas du modèle.
 *
 * Un modèle annonce sa propre confiance avec le même aplomb qu'il ait raison
 * ou tort. Ces trois boutons sont la seule façon de savoir, avec le temps, si
 * une skill mérite qu'on lui consacre de l'allocation.
 */
function Retour({ runId }: { runId: string }) {
  const [envoye, setEnvoye] = useState(false);

  const send = useMutation({
    mutationFn: (verdict: "utile" | "partiel" | "inutile") =>
      api.post("/ai/feedback", { runId, verdict }),
    onSuccess: () => {
      setEnvoye(true);
      toast("Merci — c'est noté");
    },
  });

  if (envoye) return null;

  return (
    <div
      className="card card--flush"
      style={{ marginTop: 9, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
    >
      <span className="muted">Cette analyse vous a servi ?</span>
      <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
        {(["utile", "partiel", "inutile"] as const).map((verdict) => (
          <button
            key={verdict}
            className="btn btn--ghost btn--small"
            disabled={send.isPending}
            onClick={() => send.mutate(verdict)}
          >
            {verdict}
          </button>
        ))}
      </div>
    </div>
  );
}
