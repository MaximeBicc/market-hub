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
  const [deplie, setDeplie] = useState(true);

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
          description: fiche.description,
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
                        <img src={url} alt="" loading="lazy" />
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

              {/* Les déclinaisons, dépliables */}
              <div className="field">
                <button
                  type="button"
                  className="declinaisons-entete"
                  onClick={() => setDeplie(!deplie)}
                  aria-expanded={deplie}
                >
                  <Icon name={deplie ? "chevronLeft" : "chevronRight"} />
                  <span>
                    {fiche.declinaisons.length} déclinaison
                    {fiche.declinaisons.length > 1 ? "s" : ""}
                    {fiche.axes.length > 0 && ` · ${fiche.axes.join(" × ")}`}
                  </span>
                  <span className="muted">{total} unités au total</span>
                </button>

                {deplie && (
                  <div className="declinaisons-liste">
                    {fiche.declinaisons.map((d) => {
                      const c = choix[d.optionKey] ?? { stock: 0, prix: "" };
                      const propre = c.prix.trim() ? centimes(c.prix) : null;
                      return (
                        <div className="decl-import" key={d.optionKey}>
                          {d.image ? (
                            <img src={d.image} alt="" loading="lazy" />
                          ) : (
                            <span className="decl-import__vide">—</span>
                          )}
                          <div className="decl-import__nom">
                            <b>{d.nom}</b>
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
                            title={
                              propre === null
                                ? "Vide : suit le prix commun"
                                : "Prix particulier à cette déclinaison"
                            }
                            value={c.prix}
                            onChange={(e) =>
                              setChoix((s) => ({
                                ...s,
                                [d.optionKey]: { ...c, prix: e.target.value },
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
                )}
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
