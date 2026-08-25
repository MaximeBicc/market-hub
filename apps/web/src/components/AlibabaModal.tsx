import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money } from "../lib/api.js";
import { Icon } from "./Icon.js";
import { toast } from "./Toast.js";

interface DeclinaisonAlibaba {
  skuId: string;
  nom: string;
  optionValues: string[];
  optionKey: string;
  image: string | null;
  prixPalier: number | null;
  coutDebarque: number | null;
}

interface FicheAlibaba {
  productId: string;
  titre: string;
  description: string;
  categorie: string | null;
  fournisseur: string | null;
  lien: string | null;
  devise: string;
  quantiteMinimale: number;
  images: string[];
  axes: string[];
  caracteristiques: Array<{ nom: string; valeur: string }>;
  logistique: Array<{ nom: string; valeur: string }>;
  declinaisons: DeclinaisonAlibaba[];
  coutDebarqueUnitaire: number | null;
}

/** Ce que l'utilisateur décide, par déclinaison. */
interface Choix {
  stock: number;
  /** Prix en euros, saisi. Vide = suit le prix commun. */
  prix: string;
}

/** Euros saisis vers centimes, tolérant la virgule française. */
function centimes(saisie: string): number {
  const n = parseFloat(String(saisie).replace(",", ".").trim());
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * Les vignettes passent par notre serveur.
 *
 * En direct, les adresses du CDN d'Alibaba ne s'affichaient pas dans
 * l'application — entre la politique de sécurité de la page, le service worker
 * et le référent, trois causes possibles qu'on ne départage pas. Relayées,
 * elles deviennent une ressource de même origine et plus rien ne s'interpose.
 */
function vignette(url: string | null): string | undefined {
  if (!url) return undefined;
  return `/api/alibaba/image?u=${encodeURIComponent(url)}`;
}

/**
 * Les déclinaisons rangées par l'axe choisi.
 *
 * Un étui de téléphone existe en huit modèles et six couleurs : quarante-huit
 * lignes à plat, illisibles. Groupées, ce sont huit lignes qu'on déplie.
 *
 * QUEL AXE PORTE LE GROUPEMENT NE SE DEVINE PAS. Alibaba énumère ses attributs
 * dans l'ordre qui l'arrange — sur cet étui, la couleur vient avant le modèle
 * — et grouper sur le premier venu donnait la hiérarchie à l'envers. C'est
 * donc un choix, avec un défaut sensé plutôt qu'un tirage au sort.
 *
 * `axe` à -1 : pas de groupement, la liste reste plate. C'est le cas d'un
 * produit à un seul axe, où une hiérarchie ajouterait un clic pour ne rien
 * révéler.
 */
function grouper(
  declinaisons: DeclinaisonAlibaba[],
  axe: number,
): Array<{ titre: string; lignes: DeclinaisonAlibaba[] }> {
  if (axe < 0) return [{ titre: "", lignes: declinaisons }];

  const paquets = new Map<string, DeclinaisonAlibaba[]>();
  for (const d of declinaisons) {
    // L'ordre d'arrivée fait l'ordre d'affichage : c'est celui du fournisseur,
    // et il est plus sensé qu'un tri alphabétique sur « iPhone 15 / 16 / 17 ».
    const cle = d.optionValues[axe] || "—";
    const liste = paquets.get(cle);
    if (liste) liste.push(d);
    else paquets.set(cle, [d]);
  }
  return [...paquets].map(([titre, lignes]) => ({ titre, lignes }));
}

/**
 * L'axe de groupement par défaut : celui qui découpe le plus.
 *
 * À nombre égal de déclinaisons, l'axe le plus riche donne beaucoup de lignes
 * courtes plutôt que quelques lignes interminables. Huit modèles de six
 * couleurs se lisent mieux en huit lignes de six qu'en six lignes de huit —
 * on cherche d'abord ce que l'article équipe, la teinte vient après.
 *
 * Les noms d'axes ne sont pas fiables pour trancher : Alibaba les traduit
 * sans dire dans quelle langue, et « Modèle applicable » ou « Compatible
 * avec » désignent la même chose sans se ressembler. Compter les valeurs ne
 * dépend d'aucune langue.
 */
function axeParDefaut(declinaisons: DeclinaisonAlibaba[], axes: string[]): number {
  if (axes.length < 2) return -1;
  let meilleur = 0;
  let record = -1;
  for (let i = 0; i < axes.length; i++) {
    const distinctes = new Set(declinaisons.map((d) => d.optionValues[i] ?? ""))
      .size;
    // Strictement supérieur : à égalité, le premier axe d'Alibaba l'emporte,
    // et l'ordre reste stable d'un import à l'autre.
    if (distinctes > record) {
      record = distinctes;
      meilleur = i;
    }
  }
  return meilleur;
}

/**
 * Importer un produit fournisseur depuis un lien Alibaba.
 *
 * Le geste est en deux temps, et c'est délibéré : on LIT d'abord, on décide
 * ensuite. Enregistrer dès la lecture remplirait le stock de fiches ouvertes
 * par curiosité, qu'il faudrait supprimer une à une.
 *
 * Tout ce qui vient d'Alibaba est repris tel quel — titre, description,
 * photos, déclinaisons, coût débarqué. Trois choses seulement se décident
 * ici, parce qu'elles n'existent pas chez le fournisseur : les photos qu'on
 * garde, le prix auquel on vend, et le stock qu'on possède.
 */
export function AlibabaModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();

  const [lien, setLien] = useState("");
  const [fiche, setFiche] = useState<FicheAlibaba | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const [photos, setPhotos] = useState<Set<string>>(new Set());
  const [prixCommun, setPrixCommun] = useState("");
  const [choix, setChoix] = useState<Record<string, Choix>>({});
  /** Les groupes ouverts. Tout est replié au départ : on voit la structure
      avant le détail, et un produit à huit modèles tient dans l'écran. */
  const [ouverts, setOuverts] = useState<Set<string>>(new Set());
  /** L'axe qui porte le groupement. -1 : liste plate. */
  const [axeGroupe, setAxeGroupe] = useState(-1);
  /**
   * Les déclinaisons cochées.
   *
   * Elles désignent qui reçoit les poses de stock en masse — RIEN D'AUTRE.
   * Décocher n'exclut pas de l'import : les déclinaisons du fournisseur
   * partent toutes en base, celles à zéro comprises. Une déclinaison absente
   * du catalogue ne pourrait jamais recevoir de stock plus tard sans un
   * nouvel import.
   */
  const [cochees, setCochees] = useState<Set<string>>(new Set());
  const [poseChacun, setPoseChacun] = useState("");
  const [poseTotal, setPoseTotal] = useState("");

  const lire = useMutation({
    mutationFn: async () => {
      setErreur(null);
      const r = await api.get<{ fiche: FicheAlibaba }>(
        `/alibaba/fiche?url=${encodeURIComponent(lien.trim())}`,
      );
      return r.fiche;
    },
    onSuccess: (f) => {
      setFiche(f);
      setAxeGroupe(axeParDefaut(f.declinaisons, f.axes));
      setOuverts(new Set());
      // Tout coché d'emblée : le cas courant est d'acheter la gamme entière.
      setCochees(new Set(f.declinaisons.map((d) => d.optionKey)));
      setPoseChacun("");
      setPoseTotal("");
      // Toutes les photos retenues d'emblée : décocher est plus rapide que
      // cocher six cases pour un produit qu'on veut entier.
      setPhotos(new Set(f.images));
      setChoix(
        Object.fromEntries(
          f.declinaisons.map((d) => [d.optionKey, { stock: 0, prix: "" }]),
        ),
      );
    },
    onError: (e: unknown) =>
      setErreur(e instanceof Error ? e.message : "Lecture impossible"),
  });

  const importer = useMutation({
    mutationFn: async () => {
      if (!fiche) return;
      const commun = centimes(prixCommun);
      if (commun <= 0) throw new Error("Indiquez un prix de vente.");

      return api.post<{ ok: boolean; id: string; declinaisons: number }>(
        "/alibaba/importer",
        {
          productId: fiche.productId,
          titre: fiche.titre,
          /*
           * Les caractéristiques rejoignent la description.
           *
           * Sans ça, elles ne vivraient que le temps de cette fenêtre : notre
           * modèle de produit n'a pas de champ pour « Sac d'OPP » ni pour un
           * délai de préparation. Les perdre obligerait à rouvrir la fiche
           * Alibaba au moment de rédiger l'annonce.
           */
          description: [
            fiche.description,
            [...fiche.caracteristiques, ...fiche.logistique].length > 0
              ? "\n\nInformations fournisseur\n" +
                [...fiche.caracteristiques, ...fiche.logistique]
                  .map((c) => `${c.nom} : ${c.valeur}`)
                  .join("\n")
              : "",
          ]
            .filter(Boolean)
            .join(""),
          categorie: fiche.categorie,
          lien: fiche.lien,
          images: fiche.images.filter((u) => photos.has(u)),
          prixVente: commun,
          coutDebarque: fiche.coutDebarqueUnitaire,
          axes: fiche.axes,
          declinaisons: fiche.declinaisons.map((d) => {
            const c = choix[d.optionKey] ?? { stock: 0, prix: "" };
            return {
              skuId: d.skuId,
              nom: d.nom,
              optionKey: d.optionKey,
              optionValues: d.optionValues,
              image: d.image,
              // Un prix laissé vide suit le prix commun : c'est le cas
              // ordinaire, et forcer une saisie par coloris serait pénible.
              prixVente: c.prix.trim() ? centimes(c.prix) : commun,
              stock: c.stock,
              coutDebarque: d.coutDebarque,
            };
          }),
        },
      );
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["variantes"] });
      toast(`Produit importé — ${r?.declinaisons ?? 0} déclinaisons`);
      onClose();
    },
    onError: (e: unknown) =>
      setErreur(e instanceof Error ? e.message : "Import impossible"),
  });

  const total = fiche
    ? Object.values(choix).reduce((n, c) => n + (Number(c.stock) || 0), 0)
    : 0;
  const communCts = centimes(prixCommun);

  /** Efface les prix particuliers : tout retombe sur le prix commun. */
  const realigner = () =>
    setChoix((c) =>
      Object.fromEntries(
        Object.entries(c).map(([k, v]) => [k, { ...v, prix: "" }]),
      ),
    );
  const desalignes = Object.values(choix).filter((c) => c.prix.trim()).length;

  const groupes = fiche ? grouper(fiche.declinaisons, axeGroupe) : [];

  /**
   * Le prix affiché sur la ligne d'un modèle.
   *
   * Vide dès que ses coloris ne s'accordent pas : montrer l'un d'eux
   * laisserait croire que tout le modèle est à ce prix.
   */
  const prixGroupe = (lignes: DeclinaisonAlibaba[]): string => {
    const valeurs = new Set(
      lignes.map((d) => (choix[d.optionKey]?.prix ?? "").trim()),
    );
    return valeurs.size === 1 ? [...valeurs][0]! : "";
  };

  /** Pose un prix sur tous les coloris d'un modèle d'un seul geste. */
  const poserPrixGroupe = (lignes: DeclinaisonAlibaba[], prix: string) =>
    setChoix((s) => {
      const n = { ...s };
      for (const d of lignes) {
        n[d.optionKey] = { ...(n[d.optionKey] ?? { stock: 0, prix: "" }), prix };
      }
      return n;
    });

  /**
   * Le stock affiché sur la ligne d'un modèle.
   *
   * Vide dès que ses coloris divergent — comme le prix. Y montrer la somme
   * inviterait à la corriger, et le nombre saisi partirait alors à
   * l'identique sur chaque coloris : on aurait tapé 60 et obtenu 360.
   * La somme a sa propre colonne, à droite, en lecture seule.
   */
  const stockGroupeCommun = (lignes: DeclinaisonAlibaba[]): string => {
    const valeurs = new Set(lignes.map((d) => choix[d.optionKey]?.stock ?? 0));
    return valeurs.size === 1 ? String([...valeurs][0]) : "";
  };

  /** Les déclinaisons cochées, dans l'ordre de la liste. */
  const cibles = (fiche?.declinaisons ?? []).filter((d) =>
    cochees.has(d.optionKey),
  );
  const toutesCochees =
    Boolean(fiche) && cibles.length === fiche!.declinaisons.length;

  /**
   * LA MÊME QUANTITÉ SUR CHAQUE DÉCLINAISON COCHÉE.
   *
   * C'est la première façon d'acheter : « dix de chaque coloris ». Le nombre
   * saisi est celui de CHACUNE, pas du total — le total s'affiche à côté pour
   * qu'aucune confusion ne survive à la lecture.
   */
  const poserSurChacune = () => {
    const n = Math.max(0, Math.round(Number(poseChacun) || 0));
    setChoix((s) => {
      const suite = { ...s };
      for (const d of cibles) {
        suite[d.optionKey] = {
          ...(suite[d.optionKey] ?? { stock: 0, prix: "" }),
          stock: n,
        };
      }
      return suite;
    });
  };

  /**
   * UN TOTAL, RÉPARTI SUR LES DÉCLINAISONS COCHÉES.
   *
   * L'autre façon d'acheter : « cent pièces au total, panachées ». La
   * division tombe rarement juste ; le reste va aux PREMIÈRES de la liste,
   * une unité chacune. Cent sur six donne 17, 17, 17, 17, 16, 16 — et non
   * cinq fois seize avec vingt pièces égarées.
   */
  const repartir = () => {
    if (cibles.length === 0) return;
    const total = Math.max(0, Math.round(Number(poseTotal) || 0));
    const base = Math.floor(total / cibles.length);
    const reste = total % cibles.length;
    setChoix((s) => {
      const suite = { ...s };
      cibles.forEach((d, i) => {
        suite[d.optionKey] = {
          ...(suite[d.optionKey] ?? { stock: 0, prix: "" }),
          stock: base + (i < reste ? 1 : 0),
        };
      });
      return suite;
    });
  };

  /** Coche ou décoche d'un geste toutes les déclinaisons d'un modèle. */
  const basculerGroupe = (lignes: DeclinaisonAlibaba[]) => {
    const toutes = lignes.every((d) => cochees.has(d.optionKey));
    setCochees((s) => {
      const n = new Set(s);
      for (const d of lignes) {
        if (toutes) n.delete(d.optionKey);
        else n.add(d.optionKey);
      }
      return n;
    });
  };

  /** Pose la même quantité sur chaque coloris — « j'en ai reçu dix de chaque ». */
  const poserStockGroupe = (lignes: DeclinaisonAlibaba[], brut: string) => {
    const n = Math.max(0, Number(brut) || 0);
    setChoix((s) => {
      const suite = { ...s };
      for (const d of lignes) {
        suite[d.optionKey] = {
          ...(suite[d.optionKey] ?? { stock: 0, prix: "" }),
          stock: n,
        };
      }
      return suite;
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: 760 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h3 style={{ margin: 0 }}>Importer depuis Alibaba</h3>
            <p className="muted" style={{ margin: "4px 0 0" }}>
              Collez l'adresse de la page produit. Tout est repris — vous
              choisissez les photos, le prix et le stock.
            </p>
          </div>
          <button type="button" className="qty-btn" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <div className="modal-body">
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              type="text"
              className="input"
              placeholder="https://french.alibaba.com/product-detail/..."
              value={lien}
              onChange={(e) => setLien(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && lien.trim()) lire.mutate();
              }}
            />
            <button
              type="button"
              className="btn btn--primary"
              disabled={!lien.trim() || lire.isPending}
              onClick={() => lire.mutate()}
            >
              {lire.isPending ? "Lecture…" : "Lire la fiche"}
            </button>
          </div>

          {erreur && (
            <div className="banner banner--warn" style={{ marginBottom: 12 }}>
              <span className="banner__b">{erreur}</span>
            </div>
          )}

          {fiche && (
            <>
              <div className="field">
                <label className="field__label">Produit</label>
                <p style={{ margin: "0 0 4px", fontWeight: 600 }}>
                  {fiche.titre}
                </p>
                <p className="row__s" style={{ whiteSpace: "normal", margin: 0 }}>
                  {fiche.fournisseur}
                  {fiche.categorie ? ` · ${fiche.categorie}` : ""} · référence{" "}
                  {fiche.productId} · minimum de commande{" "}
                  {fiche.quantiteMinimale}
                  {fiche.coutDebarqueUnitaire != null && (
                    <>
                      {" · "}coût débarqué{" "}
                      <b>{money(fiche.coutDebarqueUnitaire)}</b> la pièce, fret
                      compris
                    </>
                  )}
                </p>
              </div>

              {(fiche.caracteristiques.length > 0 ||
                fiche.logistique.length > 0) && (
                <p className="row__s" style={{ whiteSpace: "normal", margin: "-6px 0 12px" }}>
                  {/* Ce qui vaut pour toutes les pièces : gardé comme
                      information, écarté des déclinaisons. Un menu déroulant
                      à un seul choix n'a de sens sur aucune plateforme. */}
                  {[...fiche.caracteristiques, ...fiche.logistique]
                    .map((c) => `${c.nom} : ${c.valeur}`)
                    .join(" · ")}
                </p>
              )}

              {/* Les photos : toutes montrées, à décocher */}
              <div className="field">
                <label className="field__label">
                  Photos — {photos.size} retenue{photos.size > 1 ? "s" : ""} sur{" "}
                  {fiche.images.length}
                </label>
                <div className="photos-grille">
                  {fiche.images.map((url) => {
                    const prise = photos.has(url);
                    return (
                      <button
                        type="button"
                        key={url}
                        className={`photo-choix ${prise ? "photo-choix--prise" : ""}`}
                        title={prise ? "Retirer cette photo" : "Reprendre cette photo"}
                        onClick={() =>
                          setPhotos((s) => {
                            const n = new Set(s);
                            if (n.has(url)) n.delete(url);
                            else n.add(url);
                            return n;
                          })
                        }
                      >
                        <img
                          src={vignette(url)}
                          alt=""
                          loading="lazy"
                          title={url}
                        />
                        {prise && <span className="photo-choix__coche">✓</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Le prix commun */}
              <div className="field">
                <label className="field__label">
                  Prix de vente — appliqué à toutes les déclinaisons
                </label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="text"
                    className="input font-mono"
                    style={{ maxWidth: 140 }}
                    placeholder="24,90"
                    value={prixCommun}
                    onChange={(e) => setPrixCommun(e.target.value)}
                  />
                  <span className="row__s">EUR</span>
                  {desalignes > 0 && (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={realigner}
                      title="Efface les prix particuliers : tout revient au prix commun"
                    >
                      <Icon name="refresh" /> Tout remettre à ce prix (
                      {desalignes})
                    </button>
                  )}
                </div>
                {communCts > 0 && fiche.coutDebarqueUnitaire != null && (
                  <p className="row__s" style={{ whiteSpace: "normal", marginTop: 6 }}>
                    Marge à ce prix :{" "}
                    <b>{money(communCts - fiche.coutDebarqueUnitaire)}</b> la
                    pièce
                    {communCts > 0 && (
                      <>
                        {" "}
                        ({Math.round(
                          ((communCts - fiche.coutDebarqueUnitaire) /
                            communCts) *
                            100,
                        )}
                        %)
                      </>
                    )}
                    {communCts <= fiche.coutDebarqueUnitaire && (
                      <b style={{ color: "var(--danger, #e5484d)" }}>
                        {" "}
                        — vous vendriez à perte
                      </b>
                    )}
                  </p>
                )}
              </div>

              {/* Les deux façons d'entrer du stock */}
              <div className="field">
                <div className="poses__tete">
                  <span className="field__label" style={{ margin: 0 }}>
                    Stock — sur {cibles.length} déclinaison
                    {cibles.length > 1 ? "s" : ""} cochée
                    {cibles.length > 1 ? "s" : ""}
                  </span>
                  {/* Le libellé suit l'état : après avoir écarté trois
                      coloris, on veut tout reprendre ; une fois tout coché,
                      le seul geste utile est l'inverse. */}
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() =>
                      setCochees(
                        toutesCochees
                          ? new Set()
                          : new Set(fiche.declinaisons.map((d) => d.optionKey)),
                      )
                    }
                  >
                    {toutesCochees ? "Tout décocher" : "Tout cocher"}
                  </button>
                </div>
                <div className="poses">
                  <div className="poses__bloc">
                    <input
                      type="number"
                      min="0"
                      className="input font-mono"
                      placeholder="10"
                      value={poseChacun}
                      onChange={(e) => setPoseChacun(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={cibles.length === 0 || !poseChacun.trim()}
                      onClick={poserSurChacune}
                    >
                      sur chacune
                    </button>
                    <span className="row__s">
                      {poseChacun.trim() && cibles.length > 0
                        ? `soit ${Math.max(0, Math.round(Number(poseChacun) || 0)) * cibles.length} au total`
                        : "la même quantité partout"}
                    </span>
                  </div>

                  <div className="poses__bloc">
                    <input
                      type="number"
                      min="0"
                      className="input font-mono"
                      placeholder="100"
                      value={poseTotal}
                      onChange={(e) => setPoseTotal(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={cibles.length === 0 || !poseTotal.trim()}
                      onClick={repartir}
                    >
                      à répartir
                    </button>
                    <span className="row__s">
                      {poseTotal.trim() && cibles.length > 0
                        ? `soit ${Math.floor((Number(poseTotal) || 0) / cibles.length)} ou ${Math.floor((Number(poseTotal) || 0) / cibles.length) + 1} chacune`
                        : "un total, divisé entre elles"}
                    </span>
                  </div>
                </div>
                <p className="row__s" style={{ whiteSpace: "normal", marginTop: 6 }}>
                  Cocher sert à désigner qui reçoit ces quantités. Toutes les
                  déclinaisons sont importées de toute façon — une déclinaison
                  absente du catalogue ne pourrait plus recevoir de stock
                  ensuite.
                </p>
              </div>

              {/* Les déclinaisons, rangées par modèle */}
              <div className="field">
                <div className="decl-entete">
                  <span className="field__label" style={{ margin: 0 }}>
                    {fiche.declinaisons.length} déclinaison
                    {fiche.declinaisons.length > 1 ? "s" : ""}
                  </span>

                  {/* Quel axe porte les lignes. Alibaba énumère ses attributs
                      dans l'ordre qui l'arrange, et ce n'est pas toujours
                      celui qui se lit le mieux. */}
                  {fiche.axes.length > 1 && (
                    <label className="decl-entete__axe">
                      Ranger par
                      <select
                        className="input"
                        value={axeGroupe}
                        onChange={(e) => {
                          setAxeGroupe(Number(e.target.value));
                          // Les groupes changent de nature : ce qui était
                          // ouvert n'a plus de sens.
                          setOuverts(new Set());
                        }}
                      >
                        {fiche.axes.map((nom, i) => (
                          <option key={nom} value={i}>
                            {nom}
                          </option>
                        ))}
                        <option value={-1}>tout à plat</option>
                      </select>
                    </label>
                  )}

                  <span className="muted">{total} unités au total</span>
                </div>

                {groupes.map((groupe) => {
                  const ouvert = !groupe.titre || ouverts.has(groupe.titre);
                  const stockGroupe = groupe.lignes.reduce(
                    (n, d) => n + (choix[d.optionKey]?.stock ?? 0),
                    0,
                  );
                  const photoGroupe =
                    groupe.lignes.find((d) => d.image)?.image ?? null;

                  return (
                    <div className="decl-groupe" key={groupe.titre || "tout"}>
                      {groupe.titre && (
                        <div className="decl-groupe__tete">
                          <input
                            type="checkbox"
                            className="decl-case"
                            title="Cocher tous les coloris de ce modèle"
                            checked={groupe.lignes.every((d) =>
                              cochees.has(d.optionKey),
                            )}
                            ref={(el) => {
                              if (!el) return;
                              const n = groupe.lignes.filter((d) =>
                                cochees.has(d.optionKey),
                              ).length;
                              // Ni tout ni rien : l'état intermédiaire ne
                              // s'exprime qu'en JavaScript, pas en HTML.
                              el.indeterminate =
                                n > 0 && n < groupe.lignes.length;
                            }}
                            onChange={() => basculerGroupe(groupe.lignes)}
                          />
                          <button
                            type="button"
                            className="chevron-variantes"
                            aria-expanded={ouvert}
                            title={
                              ouvert
                                ? "Replier"
                                : `Voir les ${groupe.lignes.length} déclinaisons`
                            }
                            onClick={() =>
                              setOuverts((s) => {
                                const n = new Set(s);
                                if (n.has(groupe.titre)) n.delete(groupe.titre);
                                else n.add(groupe.titre);
                                return n;
                              })
                            }
                          >
                            <Icon
                              name={ouvert ? "chevronLeft" : "chevronRight"}
                            />
                          </button>

                          {photoGroupe ? (
                            <img src={vignette(photoGroupe)} alt="" loading="lazy" />
                          ) : (
                            <span className="decl-import__vide">—</span>
                          )}

                          <div className="decl-import__nom">
                            <b>{groupe.titre}</b>
                            <span className="row__s">
                              {groupe.lignes.length} coloris ·{" "}
                              {stockGroupe > 0
                                ? `${stockGroupe} unités`
                                : "aucun stock"}
                            </span>
                          </div>

                          {/* Un prix posé ici descend sur tout le modèle : sur
                              huit modèles à six couleurs, le saisir coloris
                              par coloris serait quarante-huit champs. */}
                          <input
                            type="text"
                            className="input font-mono"
                            placeholder={prixCommun || "prix"}
                            title="Prix de ce modèle — s'applique à ses coloris"
                            value={prixGroupe(groupe.lignes)}
                            onChange={(e) =>
                              poserPrixGroupe(groupe.lignes, e.target.value)
                            }
                          />
                          <input
                            type="number"
                            min="0"
                            className="input font-mono"
                            style={{ textAlign: "right" }}
                            placeholder="—"
                            title="Même quantité sur chaque coloris de ce modèle"
                            value={stockGroupeCommun(groupe.lignes)}
                            onChange={(e) =>
                              poserStockGroupe(groupe.lignes, e.target.value)
                            }
                          />
                          <span className="decl-groupe__total">
                            {stockGroupe}
                          </span>
                        </div>
                      )}

                      {ouvert &&
                        groupe.lignes.map((d) => {
                          const c = choix[d.optionKey] ?? {
                            stock: 0,
                            prix: "",
                          };
                          /*
                           * La valeur qui porte le groupe est déjà sur la ligne
                           * parente : la répéter alourdirait chaque enfant. On
                           * retire donc CELLE-LÀ, pas la première — sans quoi
                           * changer d'axe afficherait « Noir » sous « Noir » et
                           * cacherait le modèle.
                           */
                          const nom =
                            groupe.titre && axeGroupe >= 0
                              ? d.optionValues
                                  .filter((_, i) => i !== axeGroupe)
                                  .filter(Boolean)
                                  .join(" · ")
                              : d.nom;
                          return (
                            <div
                              className={`decl-import ${groupe.titre ? "decl-import--fille" : ""}`}
                              key={d.optionKey}
                            >
                              <input
                                type="checkbox"
                                className="decl-case"
                                title="Recevoir les quantités posées en haut"
                                checked={cochees.has(d.optionKey)}
                                onChange={() =>
                                  setCochees((s) => {
                                    const n = new Set(s);
                                    if (n.has(d.optionKey)) n.delete(d.optionKey);
                                    else n.add(d.optionKey);
                                    return n;
                                  })
                                }
                              />
                              {d.image ? (
                                <img
                                  src={vignette(d.image)}
                                  alt=""
                                  loading="lazy"
                                  title={d.image}
                                />
                              ) : (
                                <span className="decl-import__vide">—</span>
                              )}
                              <div className="decl-import__nom">
                                <b>{nom || "sans déclinaison"}</b>
                                {d.coutDebarque != null && (
                                  <span className="row__s">
                                    revient {money(d.coutDebarque)}
                                  </span>
                                )}
                              </div>
                              <input
                                type="text"
                                className="input font-mono"
                                placeholder={prixCommun || "prix"}
                                title="Vide : suit le prix commun"
                                value={c.prix}
                                onChange={(e) =>
                                  setChoix((s) => ({
                                    ...s,
                                    [d.optionKey]: {
                                      ...c,
                                      prix: e.target.value,
                                    },
                                  }))
                                }
                              />
                              <input
                                type="number"
                                min="0"
                                className="input font-mono"
                                style={{ textAlign: "right" }}
                                value={c.stock}
                                onChange={(e) =>
                                  setChoix((s) => ({
                                    ...s,
                                    [d.optionKey]: {
                                      ...c,
                                      stock: Math.max(
                                        0,
                                        Number(e.target.value) || 0,
                                      ),
                                    },
                                  }))
                                }
                              />
                            </div>
                          );
                        })}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Annuler
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!fiche || importer.isPending}
            onClick={() => importer.mutate()}
          >
            {importer.isPending
              ? "Enregistrement…"
              : `Ajouter au stock${total > 0 ? ` — ${total} unités` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
