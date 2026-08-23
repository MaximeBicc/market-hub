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

      <p className="muted" style={{ margin: "0 0 14px", lineHeight: 1.55 }}>
        Un produit, une fiche, plusieurs boutiques. Tout ce qui part d'ici est
        créé <b>en brouillon</b> : la mise en vente reste un geste que vous
        faites vous-même chez la plateforme.
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
        <div className="banner banner--warn" style={{ marginTop: 0 }}>
          <span className="banner__t">Pourquoi ces trois questions</span>
          <span className="banner__b">
            Elles étaient répondues d'office par le code : « neuf », « fait
            main par moi », « à la commande ». Sur de la revente c'est une
            fausse déclaration, et Etsy suspend des boutiques pour ce motif.
            Tant qu'elles sont vides, la diffusion est refusée au lieu
            d'inventer une réponse.
          </span>
        </div>

        <div className="field">
          <label htmlFor="cond">État de l'article — exigé par eBay</label>
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
          <label htmlFor="qui">Qui l'a fabriqué — exigé par Etsy</label>
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
          <label htmlFor="quand">Quand — exigé par Etsy</label>
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

        {/* Les deux référentiels n'ont aucune correspondance : chercher se
            fait deux fois, chez chacun. */}
        {boutiques
          .filter((b) => b.plateforme === "ebay" || b.plateforme === "etsy")
          .map((b) => (
            <ChercheCategorie
              key={b.id}
              accountId={b.id}
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

      {/* ---- Photos -------------------------------------------------- */}
      <h2 className="sec">Photos <span>{photos.length}</span></h2>
      <div className="card">
        <p className="muted" style={{ margin: "0 0 10px", lineHeight: 1.5 }}>
          Des adresses en <b>HTTPS</b> uniquement — eBay refuse tout le reste,
          et une annonce sans photo ne peut jamais être mise en vente chez Etsy.
          Les plateformes téléchargent l'image et en gardent leur propre copie.
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
          <p className="muted" style={{ marginTop: 10, lineHeight: 1.55 }}>
            Rien n'est en vente. Chaque brouillon est à relire puis à publier
            depuis la plateforme. Vous pouvez relancer sans risque : une
            boutique où l'annonce existe déjà est laissée telle quelle.
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
function ChercheCategorie({
  accountId,
  titre,
  defaut,
  valeur,
  onChoix,
}: {
  accountId: string;
  titre: string;
  defaut: string;
  valeur: string;
  onChoix: (id: string) => void;
}) {
  const [texte, setTexte] = useState(defaut.slice(0, 60));
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
