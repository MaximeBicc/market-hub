import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, money } from "../lib/api.js";
import { Icon } from "../components/Icon.js";
import { toast } from "../components/Toast.js";

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
 * Ce qui est créé est un BROUILLON partout. La mise en vente reste un geste
 * humain, dans l'interface de la plateforme — publier engage un contrat de
 * vente, et Etsy facture chaque publication.
 */

interface ProduitRow {
  id: string;
  sku: string;
  title: string;
  priceAmount: number;
  priceCurrency: string;
  stock: number;
  images: string[] | string | null;
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
  success: { libelle: "créé", cls: "pill--ok" },
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

export function Publier() {
  const [choisi, setChoisi] = useState<string | null>(null);

  const { data: produits } = useQuery({
    queryKey: ["produits-publier"],
    queryFn: () => api.get<{ products: ProduitRow[] }>("/products"),
  });

  const liste = produits?.products ?? [];
  const produit = liste.find((p) => p.id === choisi) ?? null;

  return (
    <>
      <div className="page-head">
        <h1>Publier</h1>
      </div>

      <p className="muted" style={{ margin: "0 0 12px" }}>
        Une fiche, plusieurs boutiques. Tout part en <b>brouillon</b> — la mise
        en vente reste votre geste.
      </p>

      {liste.length === 0 && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Aucun produit. Créez-en un depuis l'onglet Stock, puis revenez ici
            pour le diffuser.
          </p>
        </div>
      )}

      {liste.length > 0 && !produit && (
        <div className="rows">
          {liste.map((p) => (
            <button
              className="row"
              key={p.id}
              onClick={() => setChoisi(p.id)}
              style={{ textAlign: "left", width: "100%", cursor: "pointer" }}
            >
              <span className="mono-badge">{p.sku.slice(0, 2).toUpperCase()}</span>
              <div className="row__main">
                <div className="row__t">{p.title}</div>
                <div className="row__s">
                  {p.sku} · {money(p.priceAmount, p.priceCurrency)} · stock {p.stock}
                </div>
              </div>
              <div className="row__end">
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

  const [condition, setCondition] = useState(produit.condition ?? "");
  const [whoMade, setWhoMade] = useState(produit.whoMade ?? "");
  const [whenMade, setWhenMade] = useState(produit.whenMade ?? "");
  const [ebayCategoryId, setEbayCategoryId] = useState(donnees["ebayCategoryId"] ?? "");
  const [etsyTaxonomyId, setEtsyTaxonomyId] = useState(donnees["etsyTaxonomyId"] ?? "");
  const [photos, setPhotos] = useState<string[]>(imagesDe(produit));
  const [nouvellePhoto, setNouvellePhoto] = useState("");
  const [cibles, setCibles] = useState<Set<string>>(new Set());
  const [resultats, setResultats] = useState<Resultat[] | null>(null);

  const { data: catalogue } = useQuery({
    queryKey: ["catalogue"],
    queryFn: () => api.get<{ boutiques: BoutiqueVue[] }>("/engine/catalogue"),
  });

  const enregistrer = useMutation({
    mutationFn: () =>
      api.patch<{ avertissement?: string }>(`/products/${produit.id}/diffusion`, {
        condition: condition || null,
        whoMade: whoMade || null,
        whenMade: whenMade || null,
        images: photos,
        ebayCategoryId: ebayCategoryId || null,
        etsyTaxonomyId: etsyTaxonomyId || null,
      }),
    onSuccess: async (r) => {
      toast(r.avertissement ?? "Fiche enregistrée");
      await qc.invalidateQueries({ queryKey: ["produits-publier"] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Échec"),
  });

  const publier = useMutation({
    mutationFn: () =>
      api.post<{ results: Resultat[] }>("/engine/listing", {
        productId: produit.id,
        accountIds: [...cibles],
      }),
    onSuccess: async (r) => {
      setResultats(r.results);
      await qc.invalidateQueries({ queryKey: ["produits-publier"] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Diffusion impossible"),
  });

  const boutiques = catalogue?.boutiques ?? [];
  const creation = (b: BoutiqueVue) => b.commandes.find((c) => c.id === "createListing");

  return (
    <>
      <button className="btn btn--small btn--ghost" onClick={onRetour}>
        <Icon name="chevronLeft" /> Tous les produits
      </button>

      <h2 className="sec" style={{ marginTop: 12 }}>
        {produit.title} <span>{produit.sku}</span>
      </h2>

      {/* ---- Déclarations ------------------------------------------- */}
      <div className="card">
        <details style={{ marginBottom: 10 }}>
          <summary className="muted" style={{ cursor: "pointer" }}>
            Pourquoi ces trois questions sont obligatoires
          </summary>
          <p className="row__s" style={{ whiteSpace: "normal", lineHeight: 1.45 }}>
            Elles étaient répondues d'office par le code : « neuf », « fait main
            par moi », « à la commande ». Sur de la revente, c'est une fausse
            déclaration — et Etsy suspend des boutiques pour ce motif. Vides,
            la diffusion est refusée plutôt qu'inventée.
          </p>
        </details>

        <div className="grille-decl">
        <div className="field">
          <label htmlFor="cond">État — eBay</label>
          <select
            id="cond"
            className="input"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
          >
            <option value="">— à renseigner —</option>
            {ETATS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="qui">Fabriqué par — Etsy</label>
          <select
            id="qui"
            className="input"
            value={whoMade}
            onChange={(e) => setWhoMade(e.target.value)}
          >
            <option value="">— à renseigner —</option>
            {QUI.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="quand">Quand — Etsy</label>
          <select
            id="quand"
            className="input"
            value={whenMade}
            onChange={(e) => setWhenMade(e.target.value)}
          >
            <option value="">— à renseigner —</option>
            {QUAND.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        </div>

        {/* Les deux référentiels n'ont aucune correspondance : chercher se
            fait deux fois, chez chacun. */}
        {boutiques
          .filter((b) => b.plateforme === "ebay" || b.plateforme === "etsy")
          .map((b) => (
            <ChercheCategorie
              key={b.id}
              accountId={b.id}
              plateforme={b.plateforme}
              titre={
                b.plateforme === "ebay" ? "Catégorie eBay" : "Catégorie Etsy"
              }
              defaut={produit.title}
              valeur={b.plateforme === "ebay" ? ebayCategoryId : etsyTaxonomyId}
              onChoix={(v) =>
                b.plateforme === "ebay"
                  ? setEbayCategoryId(v)
                  : setEtsyTaxonomyId(v)
              }
            />
          ))}
      </div>

      <Variantes produitId={produit.id} />

      {/* ---- Photos -------------------------------------------------- */}
      <h2 className="sec">Photos <span>{photos.length}</span></h2>
      <div className="card">
        <p className="muted" style={{ margin: "0 0 8px" }}>
          Adresses en <b>HTTPS</b> uniquement. Les plateformes téléchargent
          l'image et en gardent leur copie.
        </p>

        {photos.length > 0 && (
          <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
            {photos.map((url, i) => (
              <div key={url + i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <img
                  src={url}
                  alt=""
                  style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 6 }}
                />
                <span className="row__s" style={{ flex: 1, overflow: "hidden" }}>
                  {i === 0 ? "principale · " : ""}
                  {url}
                </span>
                <button
                  className="btn btn--small btn--ghost"
                  onClick={() => setPhotos(photos.filter((_, j) => j !== i))}
                >
                  Retirer
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="input"
            value={nouvellePhoto}
            onChange={(e) => setNouvellePhoto(e.target.value)}
            placeholder="https://…"
          />
          <button
            className="btn btn--small"
            onClick={() => {
              const u = nouvellePhoto.trim();
              if (u) setPhotos([...photos, u]);
              setNouvellePhoto("");
            }}
          >
            Ajouter
          </button>
        </div>
      </div>

      <button
        className="btn btn--wide"
        style={{ marginTop: 9 }}
        disabled={enregistrer.isPending}
        onClick={() => enregistrer.mutate()}
      >
        Enregistrer la fiche
      </button>

      {/* ---- Cibles -------------------------------------------------- */}
      <h2 className="sec">Vers quelles boutiques</h2>
      <div style={{ display: "grid", gap: 9 }}>
        {boutiques.map((b) => {
          const c = creation(b);
          const ouvert = c?.etat === "possible";
          return (
            <div className="card" key={b.id}>
              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: ouvert ? "pointer" : "default" }}>
                <input
                  type="checkbox"
                  disabled={!ouvert}
                  checked={cibles.has(b.id)}
                  onChange={(e) => {
                    const n = new Set(cibles);
                    if (e.target.checked) n.add(b.id);
                    else n.delete(b.id);
                    setCibles(n);
                  }}
                  style={{ marginTop: 3 }}
                />
                <div style={{ flex: 1 }}>
                  <div className="row__t">
                    {b.nom}{" "}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      {b.plateforme}
                    </span>
                  </div>
                  {c && c.etat !== "possible" && (
                    <div
                      className="row__s"
                      style={{ whiteSpace: "normal", lineHeight: 1.45, marginTop: 3 }}
                    >
                      {c.etat === "bloquee"
                        ? `Manque : ${c.manque?.join(", ")}. ${c.raison}`
                        : c.raison}
                    </div>
                  )}
                </div>
              </label>
            </div>
          );
        })}
      </div>

      <button
        className="btn btn--primary btn--wide"
        style={{ marginTop: 12 }}
        disabled={cibles.size === 0 || publier.isPending}
        onClick={() => publier.mutate()}
      >
        <Icon name="upload" />
        {publier.isPending
          ? "Diffusion…"
          : `Créer le brouillon sur ${cibles.size} boutique${cibles.size > 1 ? "s" : ""}`}
      </button>

      {/* ---- Résultats ----------------------------------------------- */}
      {resultats && (
        <>
          <h2 className="sec">Résultat, compte par compte</h2>
          <div className="rows">
            {resultats.map((r) => {
              const v = VERDICTS[r.status];
              const nom =
                boutiques.find((b) => b.id === r.accountId)?.nom ?? r.marketplace;
              return (
                <div className="row" key={r.accountId}>
                  <span className={`pill ${v.cls}`}>{v.libelle}</span>
                  <div className="row__main">
                    <div className="row__t">{nom}</div>
                    <div
                      className="row__s"
                      style={{ whiteSpace: "normal", lineHeight: 1.45 }}
                    >
                      {r.message ?? "—"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            Rien n'est en vente. Relancer est sans risque : une annonce déjà
            créée n'est pas recréée.
          </p>
        </>
      )}
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
