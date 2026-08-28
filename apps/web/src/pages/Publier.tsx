import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, money } from "../lib/api.js";
import { Icon } from "../components/Icon.js";
import { toast } from "../components/Toast.js";
import { PalmLoader } from "../components/PalmLoader.js";

/**
 * PUBLIER — créer une fois, diffuser vers plusieurs boutiques.
 *
 * L'écran est bâti autour d'une conviction : une diffusion vers trois
 * plateformes ne réussit pas « ou pas ». Elle réussit ici, échoue là, et
 * demande une action manuelle ailleurs — le tout dans le même clic. Un bouton
 * binaire avec un message de réussite ne peut pas dire ça honnêtement, et
 * l'utilisateur qui voit « échec » réappuie, ce qui duplique ce qui avait
 * marché.
 *
 * D'où trois partis pris :
 *
 *  1. Les cibles sont montrées AVANT, avec leur état réel et ce qui leur
 *     manque. On ne découvre pas au retour qu'eBay ne pouvait pas.
 *  2. Le résultat est détaillé par compte, jamais agrégé.
 *  3. Rejouer est sans danger : l'orchestrateur constate qu'une annonce
 *     existe déjà et ne recrée rien.
 *
 * La validation reste détaillée par boutique, mais le clic final va désormais
 * jusqu'à la mise en ligne et rend l'adresse publique de chaque annonce.
 */

interface ProduitRow {
  id: string;
  sku: string;
  title: string;
  description: string | null;
  priceAmount: number;
  priceCurrency: string;
  stock: number;
  images: string[] | string | null;
  tags: string[] | string | null;
  material: string | null;
  color: string | null;
  condition: string | null;
  whoMade: string | null;
  whenMade: string | null;
  marketplaceData: string | null;
}

interface CommandeVue {
  id: string;
  libelle: string;
  etat: "possible" | "impossible" | "bloquee";
  manque?: string[];
  raison?: string;
}

interface BoutiqueVue {
  id: string;
  plateforme: string;
  nom: string;
  statut: string;
  commandes: CommandeVue[];
}

interface Resultat {
  accountId: string;
  marketplace: string;
  status: "success" | "pending_remote" | "manual_required" | "unsupported" | "failed";
  remoteId?: string;
  url?: string;
  message?: string;
}

const ETATS: Array<[string, string]> = [
  ["new", "Neuf"],
  ["new_other", "Neuf, sans emballage d'origine"],
  ["used_excellent", "Occasion — très bon état"],
  ["used_good", "Occasion — bon état"],
  ["used_acceptable", "Occasion — état correct"],
  ["for_parts", "Pour pièces, ne fonctionne pas"],
];

const QUI: Array<[string, string]> = [
  ["someone_else", "Une autre entreprise ou personne"],
  ["i_did", "Moi-même"],
  ["collective", "Un collectif dont je fais partie"],
];

/**
 * Le vocabulaire d'Etsy, relevé sur sa spécification OpenAPI.
 *
 * Trois valeurs inventées figuraient ici — « 2000 – 2009 », « Avant 2000 »
 * et « Vintage » — soit la moitié de la liste. Elles n'existent pas chez
 * Etsy : les choisir faisait échouer la création en 400. Les intervalles
 * se chevauchent et ne sont pas réguliers, c'est leur liste, pas la nôtre.
 */
const QUAND: Array<[string, string]> = [
  ["made_to_order", "Fabriqué à la commande"],
  ["2020_2026", "2020 – 2026"],
  ["2010_2019", "2010 – 2019"],
  ["2007_2009", "2007 – 2009"],
  ["2000_2006", "2000 – 2006"],
  ["before_2007", "Avant 2007"],
  ["1990s", "Années 1990"],
  ["1980s", "Années 1980"],
  ["1970s", "Années 1970"],
  ["1960s", "Années 1960"],
  ["1950s", "Années 1950"],
  ["1940s", "Années 1940"],
  ["1930s", "Années 1930"],
  ["1920s", "Années 1920"],
  ["1910s", "Années 1910"],
  ["1900s", "Années 1900"],
  ["1800s", "XIXe siècle"],
  ["1700s", "XVIIIe siècle"],
  ["before_1700", "Avant 1700"],
];

const VERDICTS: Record<Resultat["status"], { libelle: string; cls: string }> = {
  success: { libelle: "en ligne", cls: "pill--ok" },
  pending_remote: { libelle: "créé, à vérifier", cls: "pill--warn" },
  manual_required: { libelle: "action requise", cls: "pill--warn" },
  unsupported: { libelle: "non applicable", cls: "pill--mute" },
  failed: { libelle: "échec", cls: "pill--stop" },
};

function imagesDe(p: ProduitRow): string[] {
  if (Array.isArray(p.images)) return p.images;
  if (typeof p.images === "string") {
    try {
      const j = JSON.parse(p.images);
      return Array.isArray(j) ? j : [];
    } catch {
      return p.images ? [p.images] : [];
    }
  }
  return [];
}

function tagsDe(p: ProduitRow): string[] {
  if (Array.isArray(p.tags)) return p.tags;
  if (typeof p.tags === "string") {
    try {
      const j = JSON.parse(p.tags);
      return Array.isArray(j) ? j : [];
    } catch {
      return p.tags.split(",").map((t) => t.trim()).filter(Boolean);
    }
  }
  return [];
}

function PlateformeBadge({ plateforme }: { plateforme: string }) {
  const nom = plateforme.toLowerCase();
  return (
    <span className={`platform-badge platform-badge--${nom}`}>
      <span aria-hidden="true">
        {nom === "ebay" ? "e" : nom === "etsy" ? "E" : "S"}
      </span>
      {nom === "ebay" ? "eBay" : nom === "etsy" ? "Etsy" : "Shopify"}
    </span>
  );
}

export function Publier() {
  const [choisi, setChoisi] = useState<string | null>(null);

  const { data: produits, isLoading } = useQuery({
    queryKey: ["produits-publier"],
    queryFn: () => api.get<{ products: ProduitRow[] }>("/products"),
  });

  const liste = produits?.products ?? [];
  const produit = liste.find((p) => p.id === choisi) ?? null;

  if (isLoading) return <PalmLoader label="Préparation de vos produits…" />;

  return (
    <>
      <div className="publish-hero">
        <div>
          <span className="publish-hero__eyebrow">Mise en ligne multicanale</span>
          <h1>Une fiche. Trois vitrines. En ligne.</h1>
          <p>
            Les données déjà connues sont préremplies. Vérifiez, choisissez vos
            boutiques et récupérez les liens publics immédiatement après l'envoi.
          </p>
        </div>
        <div className="publish-hero__platforms" aria-label="Plateformes compatibles">
          {(["ebay", "etsy", "shopify"] as const).map((p) => (
            <PlateformeBadge key={p} plateforme={p} />
          ))}
        </div>
      </div>

      {liste.length === 0 && (
        <div className="card publish-empty">
          <p className="muted" style={{ margin: 0 }}>
            Aucun produit. Créez-en un depuis l'onglet Stock, puis revenez ici
            pour le diffuser.
          </p>
        </div>
      )}

      {liste.length > 0 && !produit && (
        <div className="publish-picker">
          {liste.map((p) => (
            <button
              className="publish-product"
              key={p.id}
              onClick={() => setChoisi(p.id)}
            >
              <div className="publish-product__image">
                {imagesDe(p)[0] ? (
                  <img src={imagesDe(p)[0]} alt="" />
                ) : (
                  <span>{p.sku.slice(0, 2).toUpperCase()}</span>
                )}
              </div>
              <div className="publish-product__body">
                <div className="publish-product__title">{p.title}</div>
                <div className="publish-product__meta">
                  <span>{p.sku}</span>
                  <span>{money(p.priceAmount, p.priceCurrency)}</span>
                  <span>{p.stock} en stock</span>
                </div>
              </div>
              <div className="publish-product__arrow">
                <Icon name="chevronRight" />
              </div>
            </button>
          ))}
        </div>
      )}

      {produit && (
        <FicheDiffusion
          produit={produit}
          onRetour={() => setChoisi(null)}
        />
      )}
    </>
  );
}

function FicheDiffusion({
  produit,
  onRetour,
}: {
  produit: ProduitRow;
  onRetour: () => void;
}) {
  const qc = useQueryClient();
  const donnees = JSON.parse(produit.marketplaceData ?? "{}") as Record<string, string>;

  const [title, setTitle] = useState(produit.title);
  const [description, setDescription] = useState(produit.description ?? "");
  const [prix, setPrix] = useState((produit.priceAmount / 100).toFixed(2));
  const [tags, setTags] = useState(tagsDe(produit).join(", "));
  const [material, setMaterial] = useState(produit.material ?? "");
  const [color, setColor] = useState(produit.color ?? "");
  const [condition, setCondition] = useState(produit.condition ?? "");
  const [whoMade, setWhoMade] = useState(produit.whoMade ?? "");
  const [whenMade, setWhenMade] = useState(produit.whenMade ?? "");
  const [ebayCategoryId, setEbayCategoryId] = useState(donnees["ebayCategoryId"] ?? "");
  const [etsyTaxonomyId, setEtsyTaxonomyId] = useState(donnees["etsyTaxonomyId"] ?? "");
  const [photos, setPhotos] = useState<string[]>(imagesDe(produit));
  const [nouvellePhoto, setNouvellePhoto] = useState("");
  const [cibles, setCibles] = useState<Set<string>>(new Set());
  const [ciblesInitialisees, setCiblesInitialisees] = useState(false);
  const [resultats, setResultats] = useState<Resultat[] | null>(null);

  const { data: catalogue } = useQuery({
    queryKey: ["catalogue"],
    queryFn: () => api.get<{ boutiques: BoutiqueVue[] }>("/engine/catalogue"),
  });

  const boutiques = catalogue?.boutiques ?? [];
  const creation = (b: BoutiqueVue) => b.commandes.find((c) => c.id === "createListing");

  useEffect(() => {
    if (ciblesInitialisees || boutiques.length === 0) return;
    setCibles(
      new Set(
        boutiques
          .filter(
            (b) =>
              ["ebay", "etsy", "shopify"].includes(b.plateforme) &&
              creation(b)?.etat === "possible",
          )
          .map((b) => b.id),
      ),
    );
    setCiblesInitialisees(true);
  }, [boutiques, ciblesInitialisees]);

  const prixCentimes = Math.round(Number(prix.replace(",", ".")) * 100);
  const payload = () => ({
    title,
    description: description || null,
    priceAmount: Number.isFinite(prixCentimes) ? prixCentimes : -1,
    tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
    material: material || null,
    color: color || null,
    condition: condition || null,
    whoMade: whoMade || null,
    whenMade: whenMade || null,
    images: photos,
    ebayCategoryId: ebayCategoryId || null,
    etsyTaxonomyId: etsyTaxonomyId || null,
  });

  const enregistrer = useMutation({
    mutationFn: () =>
      api.patch<{ avertissement?: string }>(
        `/products/${produit.id}/diffusion`,
        payload(),
      ),
    onSuccess: async (r) => {
      toast(r.avertissement ?? "Fiche enregistrée");
      await qc.invalidateQueries({ queryKey: ["produits-publier"] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Échec"),
  });

  const publier = useMutation({
    mutationFn: async () => {
      // Enregistrer d'abord garantit que le texte visible dans ce panneau est
      // exactement celui envoyé, même si l'utilisateur n'a pas cliqué sur
      // « Enregistrer » entre sa dernière retouche et la publication.
      await api.patch(`/products/${produit.id}/diffusion`, payload());
      return api.post<{ results: Resultat[] }>("/engine/listing", {
        productId: produit.id,
        accountIds: [...cibles],
        publish: true,
      });
    },
    onMutate: () => setResultats(null),
    onSuccess: async (r) => {
      setResultats(r.results);
      const enLigne = r.results.filter((x) => x.status === "success").length;
      toast(
        enLigne > 0
          ? `${enLigne} annonce${enLigne > 1 ? "s" : ""} mise${enLigne > 1 ? "s" : ""} en ligne`
          : "Aucune annonce n'a pu être mise en ligne",
      );
      await qc.invalidateQueries({ queryKey: ["produits-publier"] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Diffusion impossible"),
  });

  const plateformesCibles = new Set(
    boutiques.filter((b) => cibles.has(b.id)).map((b) => b.plateforme),
  );
  const controles = [
    { ok: title.trim().length > 0, texte: "Titre renseigné" },
    { ok: description.trim().length > 0, texte: "Description renseignée" },
    { ok: prixCentimes > 0, texte: "Prix supérieur à 0 €" },
    { ok: produit.stock > 0, texte: "Stock disponible" },
    { ok: photos.length > 0, texte: "Au moins une photo" },
    ...(plateformesCibles.has("ebay")
      ? [{ ok: Boolean(condition), texte: "État déclaré pour eBay" }]
      : []),
    ...(plateformesCibles.has("etsy")
      ? [
          { ok: Boolean(whoMade), texte: "Fabricant déclaré pour Etsy" },
          { ok: Boolean(whenMade), texte: "Période déclarée pour Etsy" },
        ]
      : []),
  ];
  const pret = cibles.size > 0 && controles.every((c) => c.ok);

  return (
    <>
      <button className="btn btn--small btn--ghost publish-back" onClick={onRetour}>
        <Icon name="chevronLeft" /> Tous les produits
      </button>

      <div className="publish-editor-head">
        <div>
          <span className="publish-editor-head__sku">{produit.sku}</span>
          <h2>Préparer l'annonce</h2>
        </div>
        <span className="publish-live-pill"><i /> Publication directe</span>
      </div>

      <div className="publish-layout">
        <main className="publish-layout__main">
          <section className="card publish-section">
            <div className="publish-section__title">
              <div><span>01</span><h3>Contenu de l'annonce</h3></div>
              <div className="publish-section__badges">
                <PlateformeBadge plateforme="ebay" />
                <PlateformeBadge plateforme="etsy" />
                <PlateformeBadge plateforme="shopify" />
              </div>
            </div>
            <div className="field">
              <label htmlFor="publish-title">Titre <b>*</b></label>
              <input id="publish-title" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
              <span className="publish-field-help">Le titre eBay/Etsy sera automatiquement ajusté à leur limite.</span>
            </div>
            <div className="field">
              <label htmlFor="publish-description">Description <b>*</b></label>
              <textarea id="publish-description" className="input publish-textarea" value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} placeholder="Décrivez l'article, ses dimensions, son état et ce qui est inclus…" />
              <span className="publish-counter">{description.length} / 5 000</span>
            </div>
            <div className="publish-fields-grid">
              <div className="field">
                <label htmlFor="publish-price">Prix <b>*</b></label>
                <div className="publish-price"><input id="publish-price" className="input" inputMode="decimal" value={prix} onChange={(e) => setPrix(e.target.value)} /><span>EUR</span></div>
              </div>
              <div className="field"><label htmlFor="publish-color">Couleur</label><input id="publish-color" className="input" value={color} onChange={(e) => setColor(e.target.value)} placeholder="Ex. bleu nuit" /></div>
              <div className="field"><label htmlFor="publish-material">Matière</label><input id="publish-material" className="input" value={material} onChange={(e) => setMaterial(e.target.value)} placeholder="Ex. coton, acier" /></div>
            </div>
            <div className="field">
              <label htmlFor="publish-tags">Mots-clés</label>
              <input id="publish-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="vintage, décoration, cadeau" />
              <span className="publish-field-help">Séparez les mots-clés par une virgule · 13 maximum pour Etsy.</span>
            </div>
          </section>

          <section className="card publish-section">
            <div className="publish-section__title">
              <div><span>02</span><h3>Photos</h3></div>
              <strong>{photos.length} / 20</strong>
            </div>
            {photos.length > 0 ? (
              <div className="publish-photos">
                {photos.map((url, i) => (
                  <div className="publish-photo" key={url + i}>
                    <img src={url} alt={`Photo ${i + 1}`} />
                    {i === 0 && <span>Principale</span>}
                    <div className="publish-photo__actions">
                      {i > 0 && <button onClick={() => setPhotos([url, ...photos.filter((_, j) => j !== i)])}>★</button>}
                      <button onClick={() => setPhotos(photos.filter((_, j) => j !== i))} aria-label="Retirer la photo">×</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="publish-photo-empty"><Icon name="upload" /><b>Ajoutez au moins une photo</b><span>Une belle photo principale améliore la visibilité sur les trois plateformes.</span></div>
            )}
            <div className="publish-add-photo">
              <input className="input" value={nouvellePhoto} onChange={(e) => setNouvellePhoto(e.target.value)} placeholder="https://… (plusieurs URL séparées par une virgule)" />
              <button className="btn btn--small" onClick={() => {
                const urls = nouvellePhoto.split(/[\n,]+/).map((u) => u.trim()).filter((u) => /^https:\/\//i.test(u));
                setPhotos([...photos, ...urls].slice(0, 20));
                setNouvellePhoto("");
              }}>Ajouter</button>
            </div>
            <span className="publish-field-help">URL HTTPS uniquement. Les plateformes conservent leur propre copie.</span>
          </section>

          <section className="card publish-section">
            <div className="publish-section__title"><div><span>03</span><h3>Informations par plateforme</h3></div></div>
            <div className="publish-platform-fields">
              <div className="publish-platform-panel publish-platform-panel--ebay">
                <PlateformeBadge plateforme="ebay" />
                <div className="field"><label htmlFor="cond">État <b>*</b></label><select id="cond" className="input" value={condition} onChange={(e) => setCondition(e.target.value)}><option value="">À renseigner</option>{ETATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                {boutiques.filter((b) => b.plateforme === "ebay").map((b) => <ChercheCategorie key={b.id} accountId={b.id} plateforme="ebay" titre="Catégorie" defaut={title} valeur={ebayCategoryId} onChoix={setEbayCategoryId} />)}
              </div>
              <div className="publish-platform-panel publish-platform-panel--etsy">
                <PlateformeBadge plateforme="etsy" />
                <div className="field"><label htmlFor="qui">Fabriqué par <b>*</b></label><select id="qui" className="input" value={whoMade} onChange={(e) => setWhoMade(e.target.value)}><option value="">À renseigner</option>{QUI.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                <div className="field"><label htmlFor="quand">Période <b>*</b></label><select id="quand" className="input" value={whenMade} onChange={(e) => setWhenMade(e.target.value)}><option value="">À renseigner</option>{QUAND.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                {boutiques.filter((b) => b.plateforme === "etsy").map((b) => <ChercheCategorie key={b.id} accountId={b.id} plateforme="etsy" titre="Catégorie" defaut={title} valeur={etsyTaxonomyId} onChoix={setEtsyTaxonomyId} />)}
              </div>
              <div className="publish-platform-panel publish-platform-panel--shopify">
                <PlateformeBadge plateforme="shopify" />
                <p>Shopify utilise directement le titre, la description, le prix, les photos et le stock de la fiche commune.</p>
              </div>
            </div>
            <details className="publish-legal-note"><summary>Pourquoi certaines déclarations sont obligatoires ?</summary><p>eBay impose l'état de l'article. Etsy exige de déclarer qui l'a fabriqué et quand. MarketHub ne les invente jamais afin d'éviter une fausse déclaration.</p></details>
          </section>

          <Variantes produitId={produit.id} />
        </main>

        <aside className="publish-layout__aside">
          <section className="card publish-side-card">
            <h3>Boutiques de destination</h3>
            {catalogue === undefined ? (
              <PalmLoader compact label="Lecture des boutiques…" />
            ) : boutiques.length === 0 ? (
              <p className="muted">Aucune boutique compatible connectée.</p>
            ) : (
              <div className="publish-targets">
                {boutiques.map((b) => {
                  const c = creation(b);
                  const ouvert = c?.etat === "possible";
                  return <label className={`publish-target ${cibles.has(b.id) ? "publish-target--selected" : ""} ${!ouvert ? "publish-target--disabled" : ""}`} key={b.id}>
                    <input type="checkbox" disabled={!ouvert} checked={cibles.has(b.id)} onChange={(e) => { const n = new Set(cibles); e.target.checked ? n.add(b.id) : n.delete(b.id); setCibles(n); }} />
                    <div><div className="publish-target__head"><PlateformeBadge plateforme={b.plateforme} /><span>{cibles.has(b.id) ? "Prête" : ouvert ? "Disponible" : "Bloquée"}</span></div><b>{b.nom}</b>{c && !ouvert && <small>{c.etat === "bloquee" ? `Manque : ${c.manque?.join(", ")}. ${c.raison ?? ""}` : c.raison}</small>}</div>
                  </label>;
                })}
              </div>
            )}
          </section>

          <section className="card publish-side-card publish-readiness">
            <h3>Prêt à publier ?</h3>
            <div>{controles.map((c) => <span className={c.ok ? "is-ok" : "is-missing"} key={c.texte}><Icon name={c.ok ? "checkCircle" : "alert"} />{c.texte}</span>)}</div>
            <button className="btn btn--ghost btn--wide" disabled={enregistrer.isPending} onClick={() => enregistrer.mutate()}>{enregistrer.isPending ? "Enregistrement…" : "Enregistrer sans publier"}</button>
            <button className="btn btn--primary btn--wide publish-submit" disabled={!pret || publier.isPending} onClick={() => publier.mutate()}><Icon name="upload" />{publier.isPending ? "Mise en ligne…" : `Publier sur ${cibles.size} boutique${cibles.size > 1 ? "s" : ""}`}</button>
            <small>Le clic rend les annonces visibles immédiatement. Relancer ne crée aucun doublon.</small>
          </section>
        </aside>
      </div>

      {publier.isPending && <div className="card publish-progress"><PalmLoader compact label="Envoi des photos et mise en ligne sur vos boutiques…" /></div>}

      {resultats && <section className="publish-results">
        <div className="publish-results__head"><div><span>Publication terminée</span><h2>Vos annonces, boutique par boutique</h2></div></div>
        <div className="publish-results__grid">{resultats.map((r) => {
          const v = VERDICTS[r.status];
          const boutique = boutiques.find((b) => b.id === r.accountId);
          return <article className={`card publish-result publish-result--${r.status}`} key={r.accountId}>
            <div className="publish-result__top"><PlateformeBadge plateforme={r.marketplace} /><span className={`pill ${v.cls}`}>{v.libelle}</span></div>
            <h3>{boutique?.nom ?? r.marketplace}</h3>
            <p>{r.message ?? "Opération terminée."}</p>
            {r.url ? <a className="btn btn--primary btn--wide" href={r.url} target="_blank" rel="noreferrer"><Icon name="link" />Voir l'annonce en ligne</a> : <small>{r.remoteId ? `Identifiant distant : ${r.remoteId}` : "Aucun lien public disponible."}</small>}
          </article>;
        })}</div>
      </section>}
    </>
  );
}


interface Categorie {
  id: string;
  label: string;
  path?: string[];
}

/**
 * Trouver une catégorie sans connaître son numéro.
 *
 * eBay et Etsy imposent chacun un identifiant tiré de leur propre
 * référentiel — des dizaines de milliers d'entrées d'un côté, six mille de
 * l'autre, sans aucune correspondance entre les deux. Les saisir à la main
 * revient à recopier un nombre trouvé sur un forum, dont une erreur ne se
 * voit qu'au refus de publication.
 *
 * La recherche part sur VALIDATION, jamais à la frappe : Etsy n'a pas de
 * route de recherche, chaque appel télécharge son arbre entier — quelques
 * mégaoctets. Un appel par lettre tapée serait insoutenable.
 */
/**
 * Les premiers mots significatifs d'un titre.
 *
 * Le champ était pré-rempli avec le titre ENTIER — « Clip magnétique range
 * câble / Organisateur de câbles », sept mots. Une recherche de catégorie
 * porte sur un type d'objet, pas sur un intitulé commercial : plus on ajoute
 * de mots, moins on trouve.
 */
function motsCles(titre: string): string {
  return titre
    .split(/[^\p{L}\p{N}]+/u)
    .filter((m) => m.length > 2)
    .slice(0, 3)
    .join(" ");
}

function ChercheCategorie({
  accountId,
  plateforme,
  titre,
  defaut,
  valeur,
  onChoix,
}: {
  accountId: string;
  plateforme: string;
  titre: string;
  defaut: string;
  valeur: string;
  onChoix: (id: string) => void;
}) {
  const [texte, setTexte] = useState(motsCles(defaut));
  const [resultats, setResultats] = useState<Categorie[] | null>(null);

  const chercher = useMutation({
    mutationFn: () =>
      api.get<{ categories: Categorie[]; message?: string }>(
        `/engine/accounts/${accountId}/categories?q=${encodeURIComponent(texte)}`,
      ),
    onSuccess: (r) => {
      setResultats(r.categories);
      if (r.categories.length === 0) {
        toast(r.message ?? "Aucune catégorie ne correspond — essayez d'autres mots");
      }
    },
    onError: (e: unknown) =>
      toast(e instanceof Error ? e.message : "Recherche impossible"),
  });

  return (
    <div className="field">
      <label>{titre}</label>

      {valeur && (
        <div className="row__s" style={{ marginBottom: 6 }}>
          Choisie : <b>{valeur}</b>{" "}
          <button
            className="btn btn--small btn--ghost"
            onClick={() => {
              onChoix("");
              setResultats(null);
            }}
          >
            changer
          </button>
        </div>
      )}

      {!valeur && (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input"
              value={texte}
              onChange={(e) => setTexte(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  chercher.mutate();
                }
              }}
              placeholder="ex. range câble"
            />
            <button
              className="btn btn--small"
              disabled={texte.trim().length < 2 || chercher.isPending}
              onClick={() => chercher.mutate()}
            >
              {chercher.isPending ? "…" : "Chercher"}
            </button>
          </div>

          {/* Etsy ne sert son référentiel que dans une langue, et sa route
              n'accepte aucun paramètre de langue. Le dire évite de chercher
              « range câble » indéfiniment sans comprendre. */}
          {plateforme === "etsy" && (
            <span className="muted">
              Le référentiel d'Etsy est <b>en anglais</b> : cherchez « cable
              organizer » plutôt que « range câble ».
            </span>
          )}
          {plateforme === "ebay" && (
            <span className="muted">
              eBay suggère depuis votre texte, en français. Deux ou trois mots
              suffisent.
            </span>
          )}

          {resultats && resultats.length > 0 && (
            <div className="rows" style={{ marginTop: 8 }}>
              {resultats.map((c) => (
                <button
                  className="row"
                  key={c.id}
                  style={{ textAlign: "left", width: "100%", cursor: "pointer" }}
                  onClick={() => {
                    onChoix(c.id);
                    setResultats(null);
                  }}
                >
                  <div className="row__main">
                    <div className="row__t">{c.label}</div>
                    {c.path && c.path.length > 0 && (
                      <div className="row__s">{c.path.join(" › ")}</div>
                    )}
                  </div>
                  <div className="row__end">
                    <span className="muted">{c.id}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}


interface VarianteVue {
  id: string;
  sku: string | null;
  optionValues: string[];
  priceAmount: number;
  priceCurrency: string;
  status: string;
  onHand: number | null;
}

/**
 * Le stock de chaque déclinaison, visible ET modifiable.
 *
 * L'écran n'affichait que le stock du PARENT — un nombre qui n'existe pas
 * pour un produit à dix-sept coloris. Impossible de vérifier avant de
 * publier, impossible de repérer une déclinaison qui partirait à zéro.
 *
 * Ce qui est édité ici est le stock CENTRAL, pas une quantité de publication
 * à part. La nuance est tout : une seconde valeur, propre à l'annonce,
 * divergerait dès la première vente et personne ne saurait laquelle croire.
 * Écrire ici incrémente la version, donc le rapprochement POUSSERA cette
 * valeur vers les plateformes au lieu de se la faire écraser.
 */
function Variantes({ produitId }: { produitId: string }) {
  const qc = useQueryClient();
  const [saisie, setSaisie] = useState<Record<string, string>>({});

  const { data } = useQuery({
    queryKey: ["variantes", produitId],
    queryFn: () =>
      api.get<{ variantes: VarianteVue[] }>(`/products/${produitId}/variantes`),
  });

  const enregistrer = useMutation({
    mutationFn: (valeurs: Record<string, number>) =>
      api.patch<{ enregistres: number }>(
        `/products/${produitId}/stock-variantes`,
        valeurs,
      ),
    onSuccess: async (r) => {
      toast(`${r.enregistres} stock(s) enregistré(s)`);
      setSaisie({});
      await qc.invalidateQueries({ queryKey: ["variantes", produitId] });
      await qc.invalidateQueries({ queryKey: ["produits-publier"] });
    },
    onError: (e: unknown) =>
      toast(e instanceof Error ? e.message : "Enregistrement impossible"),
  });

  const variantes = (data?.variantes ?? []).filter((v) => v.status === "active");
  if (variantes.length === 0) return null;

  const valeurDe = (v: VarianteVue) =>
    saisie[v.id] ?? (v.onHand === null ? "" : String(v.onHand));

  const modifiees = Object.entries(saisie).filter(([id, val]) => {
    const v = variantes.find((x) => x.id === id);
    return v && val !== "" && Number(val) !== v.onHand;
  });

  const total = variantes.reduce((n, v) => {
    const brut = valeurDe(v);
    return n + (brut === "" ? 0 : Number(brut) || 0);
  }, 0);
  const inconnues = variantes.filter((v) => valeurDe(v) === "").length;

  return (
    <>
      <h2 className="sec">
        Déclinaisons <span>{variantes.length}</span>
      </h2>

      <div className="card">
        <p className="muted" style={{ margin: "0 0 6px" }}>
          <b>Une seule annonce</b>, avec un menu de choix. Le stock est
          modifiable — c'est le stock central, il repartira vers vos boutiques.
        </p>

        {variantes.map((v) => (
          <div className="decl" key={v.id}>
            <div>
              <div className="decl__nom">
                {v.optionValues.join(" · ") || "sans déclinaison"}
              </div>
              <div className="decl__meta">
                {v.sku ?? "sans SKU"} · {money(v.priceAmount, v.priceCurrency)}
              </div>
            </div>
            <input
              className="input decl__stock"
              type="number"
              min={0}
              inputMode="numeric"
              value={valeurDe(v)}
              placeholder="?"
              onChange={(e) => setSaisie({ ...saisie, [v.id]: e.target.value })}
            />
          </div>
        ))}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            marginTop: 10,
          }}
        >
          <span className="muted">
            {total} unité{total > 1 ? "s" : ""}
            {inconnues > 0 && (
              <span style={{ color: "var(--warn)" }}>
                {" "}
                · {inconnues} sans stock, partirai{inconnues > 1 ? "ent" : "t"} à
                zéro
              </span>
            )}
          </span>
          <button
            className="btn btn--small btn--primary"
            disabled={modifiees.length === 0 || enregistrer.isPending}
            onClick={() =>
              enregistrer.mutate(
                Object.fromEntries(modifiees.map(([id, val]) => [id, Number(val)])),
              )
            }
          >
            {modifiees.length === 0
              ? "Stock à jour"
              : `Enregistrer ${modifiees.length} stock${modifiees.length > 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </>
  );
}
