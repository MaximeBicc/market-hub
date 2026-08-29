import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, type ProductItem, type ConsumableItem } from "../lib/api.js";
import { Icon } from "./Icon.js";
import { toast } from "./Toast.js";

interface ProductModalProps {
  product?: ProductItem | null;
  consumables?: ConsumableItem[];
  onClose: () => void;
  onSuccess?: () => void;
}

/** Nettoie et convertit une saisie utilisateur (ex: "29,90" ou "29.90") en nombre valide */
function parseNumberInput(val: string | number | undefined): number {
  if (val === undefined || val === null || val === "") return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const cleaned = String(val).replace(",", ".").trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/** Ce que les boutiques ont fait du nouveau stock. */
interface RapportStock {
  boutiques?: Array<{ nom: string; plateforme: string; ok: boolean; message?: string }>;
  toutesOk?: boolean;
}

/**
 * DIRE OÙ LE STOCK EST PARTI, PAS SEULEMENT QU'IL EST ENREGISTRÉ.
 *
 * « Produit mis à jour » ne distingue pas une écriture locale d'une
 * propagation réussie vers trois boutiques — or c'est toute la différence
 * entre un stock juste et une survente. Le message nomme donc les boutiques,
 * et n'annonce jamais un succès qu'il n'a pas constaté.
 */
function messageEnregistrement(
  edition: boolean,
  rapport?: RapportStock,
): string {
  const base = edition ? "Produit mis à jour" : "Nouveau produit ajouté au stock";
  const boutiques = rapport?.boutiques ?? [];
  if (boutiques.length === 0) return `${base} !`;

  const ok = boutiques.filter((b) => b.ok).map((b) => b.nom);
  const rates = boutiques.filter((b) => !b.ok);

  if (rates.length === 0) {
    return `${base} — stock à jour sur ${ok.join(", ")}.`;
  }
  // L'échec d'abord : c'est lui qui demande une action.
  return `${base}, mais ${rates.map((b) => b.nom).join(", ")} n'a pas suivi : ${
    rates[0]?.message ?? "raison inconnue"
  }${ok.length > 0 ? ` (à jour sur ${ok.join(", ")})` : ""}`;
}

interface LigneDecl {
  /**
   * L'identifiant de la variante, quand elle existe déjà.
   *
   * Il permet d'écrire le stock d'un produit venu d'une boutique sans
   * toucher à sa structure : le nom, le SKU et le prix des coloris
   * appartiennent à la plateforme, la QUANTITÉ appartient à l'outil.
   */
  id?: string;
  /** La quantité au chargement, pour ne renvoyer que ce qui a bougé. */
  stockInitial?: number;
  valeur: string;
  sku: string;
  prixEuro: string;
  stock: number;
  /**
   * La photo propre à ce coloris.
   *
   * eBay en fait l'axe d'image de son groupe quand TOUTES les déclinaisons en
   * ont une : la vignette change alors au clic sur un coloris. Sans elle,
   * dix-sept coloris montrent la même photo et l'acheteur choisit à l'aveugle.
   */
  photo: string;
}

export function ProductModal({ product, consumables = [], onClose, onSuccess }: ProductModalProps) {
  const qc = useQueryClient();
  const isEditing = Boolean(product);

  const [sku, setSku] = useState(product?.sku ?? "");
  const [title, setTitle] = useState(product?.title ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [priceEuro, setPriceEuro] = useState<string>(
    product?.priceAmount ? (product.priceAmount / 100).toFixed(2) : "",
  );
  const [costEuro, setCostEuro] = useState<string>(
    product?.costPrice ? (product.costPrice / 100).toFixed(2) : "",
  );
  const [stock, setStock] = useState<number>(product?.stock ?? 0);
  const [minAlert, setMinAlert] = useState<number>(product?.minAlert ?? 3);
  const [location, setLocation] = useState(product?.location ?? "");
  const [weightGrams, setWeightGrams] = useState<string>(
    product?.weightGrams ? String(product.weightGrams) : "",
  );
  const [defaultConsumableId, setDefaultConsumableId] = useState(
    product?.defaultConsumableId ?? "",
  );
  const [color, setColor] = useState(product?.color ?? "");
  const [material, setMaterial] = useState(product?.material ?? "");
  const [imageUrl, setImageUrl] = useState(() => {
    if (!product?.images) return "";
    if (Array.isArray(product.images)) return product.images[0] ?? "";
    if (typeof product.images === "string") {
      try {
        const parsed = JSON.parse(product.images);
        if (Array.isArray(parsed)) return parsed[0] ?? "";
      } catch {}
      return product.images;
    }
    return "";
  });
  const [tags, setTags] = useState<string[]>(() => {
    if (!product?.tags) return [];
    if (Array.isArray(product.tags)) return product.tags;
    if (typeof product.tags === "string") {
      try {
        const parsed = JSON.parse(product.tags);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
      return (product.tags as string).split(",").map((t) => t.trim()).filter(Boolean);
    }
    return [];
  });
  const [tagInput, setTagInput] = useState("");

  /*
   * LES DÉCLINAISONS.
   *
   * Un produit qui existe en trois coloris n'a pas « un » stock : il en a
   * trois. Tant que l'API Alibaba n'est pas branchée, ces lignes se saisissent
   * à la main — c'est la seule façon de dire « il me reste zéro violet »
   * autrement qu'en le découvrant à la vente.
   */
  const [axe, setAxe] = useState("Couleur");
  const [decl, setDecl] = useState<LigneDecl[]>([]);
  /** Les déclinaisons chargées depuis le serveur, pour ne rien renvoyer d'inchangé. */
  const [declChargees, setDeclChargees] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Récupérer la liste des tags existants pour autocomplétion
  const { data: existingTagsData } = useQuery({
    queryKey: ["product-tags"],
    queryFn: () => api.get<{ tags: Array<{ name: string; count: number }> }>("/products/tags"),
  });
  const existingTags = existingTagsData?.tags ?? [];

  /*
   * Les déclinaisons déjà en base, quand on rouvre une fiche.
   *
   * Sans ce chargement, rouvrir un produit à trois coloris et enregistrer
   * effacerait les trois : le formulaire renverrait une liste vide, et la
   * route interpréterait le vide comme « plus de déclinaisons ».
   */
  const { data: declData } = useQuery({
    queryKey: ["variantes", product?.id],
    queryFn: () =>
      api.get<{
        axes: Array<{ name: string; values: string[] }>;
        variantes: Array<{
          id: string;
          sku: string | null;
          optionValues: string[];
          priceAmount: number;
          imageUrl: string | null;
          status: string;
          onHand: number | null;
        }>;
      }>(`/products/${product!.id}/variantes`),
    enabled: Boolean(product?.id),
  });

  if (declData && !declChargees) {
    const vivantes = declData.variantes.filter(
      (v) => v.status === "active" && v.optionValues.length > 0,
    );
    if (vivantes.length > 0) {
      setAxe(declData.axes[0]?.name || "Couleur");
      setDecl(
        vivantes.map((v) => ({
          id: v.id,
          stockInitial: v.onHand ?? 0,
          valeur: v.optionValues.join(" / "),
          sku: v.sku ?? "",
          prixEuro: v.priceAmount ? (v.priceAmount / 100).toFixed(2) : "",
          photo: v.imageUrl ?? "",
          stock: v.onHand ?? 0,
        })),
      );
    }
    setDeclChargees(true);
  }

  /** Vrai si ce produit vient d'une boutique : ses déclinaisons y sont écrites. */
  const synchronise = (product?.listings?.length ?? 0) > 0;
  const totalDecl = decl.reduce((n, l) => n + (Number(l.stock) || 0), 0);

  const addTag = (tagToAdd: string) => {
    const clean = tagToAdd.trim();
    if (!clean) return;
    if (!tags.some((t) => t.toLowerCase() === clean.toLowerCase())) {
      setTags([...tags, clean]);
    }
    setTagInput("");
  };

  const removeTag = (tagToRemove: string) => {
    setTags(tags.filter((t) => t.toLowerCase() !== tagToRemove.toLowerCase()));
  };

  // Calcul dynamique de la marge brute
  const saleCents = Math.round(parseNumberInput(priceEuro) * 100);
  const costCents = costEuro.trim() !== "" ? Math.round(parseNumberInput(costEuro) * 100) : null;
  const marginCents = costCents !== null ? saleCents - costCents : null;
  const marginRate =
    marginCents !== null && saleCents > 0
      ? Math.round((marginCents / saleCents) * 100)
      : null;

  const saveMutation = useMutation({
    mutationFn: async () => {
      setErrorMsg(null);
      const cleanSku = sku.trim().toUpperCase();
      const cleanTitle = title.trim();

      if (!cleanSku) {
        throw new Error("La référence SKU est obligatoire.");
      }
      if (!cleanTitle) {
        throw new Error("Le titre du produit est obligatoire.");
      }

      const payload = {
        id: product?.id,
        sku: cleanSku,
        title: cleanTitle,
        description: description.trim() || null,
        priceAmount: saleCents,
        priceCurrency: "EUR",
        costPrice: costCents,
        // Avec des déclinaisons, le stock du produit est la somme des leurs.
        // L'envoyer déjà juste évite qu'un « 0 » clignote avant le recalcul.
        stock: decl.length > 0 ? totalDecl : Math.max(0, Number(stock) || 0),
        minAlert: Math.max(1, Number(minAlert) || 3),
        location: location.trim() || null,
        weightGrams: weightGrams.trim() ? Math.max(0, Math.round(parseNumberInput(weightGrams))) : null,
        defaultConsumableId: defaultConsumableId || null,
        color: color.trim() || null,
        material: material.trim() || null,
        images: imageUrl.trim() ? [imageUrl.trim()] : [],
        tags: tags.map((t) => t.trim()).filter(Boolean),
      };

      const cree: { ok: boolean; id: string; sku: string; rapport?: RapportStock } =
        await api.post<{ ok: boolean; id: string; sku: string }>(
          "/products",
          payload,
        );

      /*
       * Les déclinaisons ensuite, et seulement si on en a.
       *
       * En second appel parce que la création du produit doit avoir réussi
       * pour qu'il y ait quelque chose à décliner. Un produit synchronisé est
       * laissé tel quel : ses coloris viennent de la boutique, et la route
       * les refuserait de toute façon.
       */
      /*
       * PRODUIT VENU D'UNE BOUTIQUE : on n'écrit QUE les quantités.
       *
       * Son nom, son SKU et son prix par coloris appartiennent à la
       * plateforme et seraient défaits au relevé suivant. Sa quantité, elle,
       * appartient à l'outil. L'écran refusait tout en bloc : on tapait 20 et
       * le chiffre revenait à sa valeur d'avant, sans un mot.
       */
      if (synchronise) {
        const changes = decl
          .filter((l) => l.id && Number(l.stock) !== l.stockInitial)
          .map((l) => ({ variantId: l.id!, stock: Math.max(0, Number(l.stock) || 0) }));
        if (changes.length > 0) {
          const r = await api.put<RapportStock>(
            `/products/${cree.id}/stocks`,
            { lignes: changes },
          );
          return { ...cree, rapport: r };
        }
      }

      if (decl.length > 0 && !synchronise) {
        const r = await api.put<RapportStock>(`/products/${cree.id}/declinaisons`, {
          axe: axe.trim() || "Couleur",
          lignes: decl
            .filter((l) => l.valeur.trim())
            .map((l) => ({
              valeur: l.valeur.trim(),
              sku: l.sku.trim() || null,
              imageUrl: l.photo.trim() || null,
              prixCentimes: l.prixEuro.trim()
                ? Math.round(parseNumberInput(l.prixEuro) * 100)
                : null,
              stock: Math.max(0, Number(l.stock) || 0),
            })),
        });
        return { ...cree, rapport: r };
      }

      return cree;
    },
    onSuccess: (cree) => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["product-tags"] });
      qc.invalidateQueries({ queryKey: ["variantes"] });
      toast(messageEnregistrement(isEditing, cree.rapport));
      onSuccess?.();
      onClose();
    },
    onError: (err: any) => {
      setErrorMsg(err?.message || "Impossible d'enregistrer le produit.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!product?.id) return;
      return api.delete(`/products/${product.id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      toast("Produit retiré du stock");
      onClose();
    },
    onError: (err: any) => {
      setErrorMsg(err?.message || "Impossible de supprimer le produit.");
    },
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: 640 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-badge-row">
              <span className="mono-badge mono-badge--small">
                <Icon name="box" />
              </span>
              <span className="modal-platform">Catalogue & Stock</span>
            </div>
            <h2 className="modal-title">
              {product ? `Modifier « ${product.title} »` : "Ajouter un produit au stock"}
            </h2>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Fermer"
          >
            <Icon name="close" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveMutation.mutate();
          }}
          className="modal-form-wrapper"
        >
          <div className="modal-body" style={{ display: "grid", gap: 16 }}>
            {errorMsg && (
              <div className="banner banner--warn" style={{ marginBottom: 4 }}>
                <span className="banner__t">Attention</span>
                <span className="banner__b">{errorMsg}</span>
              </div>
            )}

            {/* Ligne 1 : SKU et Titre */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
              <div className="field">
                <label className="field__label">
                  SKU / Référence <span style={{ color: "var(--stop)" }}>*</span>
                </label>
                <input
                  type="text"
                  className="input font-mono"
                  placeholder="EX: MUG-NOIR-01"
                  required
                  autoFocus={!isEditing}
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                />
              </div>

              <div className="field">
                <label className="field__label">
                  Titre du produit <span style={{ color: "var(--stop)" }}>*</span>
                </label>
                <input
                  type="text"
                  className="input"
                  placeholder="Ex: Mug Céramique Artisanal 350ml"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
            </div>

            {/* Ligne 2 : Prix de vente, Coût d'achat & Marge calculée */}
            <div
              style={{
                background: "var(--card-2)",
                padding: "12px 14px",
                borderRadius: 12,
                border: "1px solid var(--rule)",
                display: "grid",
                gap: 10,
              }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="field">
                  <label className="field__label">Prix de vente TTC (€)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input font-mono"
                    placeholder="24.90"
                    value={priceEuro}
                    onChange={(e) => setPriceEuro(e.target.value)}
                  />
                </div>

                <div className="field">
                  <label className="field__label">Prix d'achat / Coût unitaire (€)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input font-mono"
                    placeholder="8.50"
                    value={costEuro}
                    onChange={(e) => setCostEuro(e.target.value)}
                  />
                </div>
              </div>

              {costCents !== null && marginCents !== null && (
                <div
                  style={{
                    fontSize: 12.5,
                    display: "flex",
                    justifyContent: "space-between",
                    color: marginCents >= 0 ? "var(--ok)" : "var(--stop)",
                    fontWeight: 600,
                  }}
                >
                  <span>Marge brute estimée : {money(marginCents)}</span>
                  <span>{marginRate !== null ? `Marge : ${marginRate}%` : ""}</span>
                </div>
              )}
            </div>

            {/* Ligne 3 : Stock initial & Seuil d'alerte */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="field">
                <label className="field__label">Quantité en stock</label>
                {decl.length > 0 ? (
                  /* Avec des déclinaisons, ce champ n'a plus de sens propre :
                     le stock vit sur chaque coloris. Le laisser saisissable
                     inviterait à écrire un nombre que rien ne conserverait. */
                  <div
                    className="input font-mono"
                    style={{ textAlign: "center", fontWeight: 700, opacity: 0.75 }}
                    title="Somme des déclinaisons ci-dessous"
                  >
                    {totalDecl}
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <button
                      type="button"
                      className="qty-btn"
                      onClick={() => setStock((s) => Math.max(0, s - 1))}
                      title="-1 unité"
                    >
                      <Icon name="minus" />
                    </button>
                    <input
                      type="number"
                      min="0"
                      className="input font-mono"
                      style={{ textAlign: "center", fontWeight: 700 }}
                      value={stock}
                      onChange={(e) => setStock(Math.max(0, Number(e.target.value) || 0))}
                    />
                    <button
                      type="button"
                      className="qty-btn"
                      onClick={() => setStock((s) => s + 1)}
                      title="+1 unité"
                    >
                      <Icon name="plus" />
                    </button>
                  </div>
                )}
              </div>

              <div className="field">
                <label className="field__label">Seuil alerte stock bas</label>
                <input
                  type="number"
                  min="1"
                  className="input font-mono"
                  value={minAlert}
                  onChange={(e) => setMinAlert(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
            </div>

            {/* Les déclinaisons : un coloris par ligne, chacun son stock */}
            <div className="field">
              <label className="field__label">Déclinaisons</label>
              {synchronise ? (
                /*
                 * STRUCTURE VERROUILLÉE, QUANTITÉ OUVERTE.
                 *
                 * Ce bloc refusait TOUTE saisie parce que le produit vient
                 * d'une boutique. C'est juste pour le nom, le SKU et le prix
                 * — la plateforme les réécrit au relevé suivant — et faux
                 * pour la quantité, dont l'outil est la source de vérité.
                 * Résultat : on tapait 20, le chiffre revenait, et rien ne
                 * disait pourquoi.
                 */
                <>
                  <p className="row__s" style={{ whiteSpace: "normal", margin: "0 0 10px" }}>
                    Ce produit vient d'une boutique connectée : le nom, la
                    référence et le prix de chaque coloris y sont écrits et
                    seront réécrits au prochain relevé. <b>La quantité, elle,
                    se règle ici</b> — c'est l'outil qui fait foi, et
                    l'enregistrement la pousse sur toutes les boutiques.
                  </p>
                  {decl.map((l, i) => (
                    <div className="decl-ligne decl-ligne--lecture" key={l.id ?? i}>
                      {l.photo ? (
                        <img className="decl-vignette" src={l.photo} alt="" loading="lazy" />
                      ) : (
                        <span className="decl-vignette decl-vignette--vide" aria-hidden="true" />
                      )}
                      <span className="decl-nom">{l.valeur}</span>
                      <span className="row__s">{l.sku || "sans SKU"}</span>
                      <input
                        type="number"
                        min="0"
                        className="input font-mono"
                        style={{ textAlign: "center", fontWeight: 700 }}
                        value={l.stock}
                        title="Quantité en stock"
                        onChange={(e) =>
                          setDecl(
                            decl.map((x, j) =>
                              j === i
                                ? { ...x, stock: Math.max(0, Number(e.target.value) || 0) }
                                : x,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                </>
              ) : (
                <>
                  {decl.length > 0 && (
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        marginBottom: 8,
                      }}
                    >
                      <span className="row__s">Critère</span>
                      <input
                        type="text"
                        className="input"
                        style={{ maxWidth: 160 }}
                        value={axe}
                        placeholder="Couleur"
                        onChange={(e) => setAxe(e.target.value)}
                      />
                    </div>
                  )}

                  {decl.map((l, i) => (
                    <div className="decl-ligne" key={i}>
                      <input
                        type="text"
                        className="input"
                        placeholder="Noir"
                        value={l.valeur}
                        onChange={(e) =>
                          setDecl(
                            decl.map((x, j) =>
                              j === i ? { ...x, valeur: e.target.value } : x,
                            ),
                          )
                        }
                      />
                      <input
                        type="text"
                        className="input font-mono"
                        placeholder="SKU"
                        value={l.sku}
                        onChange={(e) =>
                          setDecl(
                            decl.map((x, j) =>
                              j === i ? { ...x, sku: e.target.value } : x,
                            ),
                          )
                        }
                      />
                      <input
                        type="text"
                        className="input font-mono"
                        placeholder={priceEuro || "prix"}
                        value={l.prixEuro}
                        onChange={(e) =>
                          setDecl(
                            decl.map((x, j) =>
                              j === i ? { ...x, prixEuro: e.target.value } : x,
                            ),
                          )
                        }
                      />
                      <input
                        type="url"
                        className="input font-mono"
                        placeholder="photo (https://…)"
                        title="Photo propre à cette déclinaison. eBay change la vignette au clic sur le coloris quand toutes en ont une."
                        value={l.photo}
                        onChange={(e) =>
                          setDecl(
                            decl.map((x, j) =>
                              j === i ? { ...x, photo: e.target.value } : x,
                            ),
                          )
                        }
                      />
                      <input
                        type="number"
                        min="0"
                        className="input font-mono"
                        style={{ textAlign: "right" }}
                        value={l.stock}
                        onChange={(e) =>
                          setDecl(
                            decl.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    stock: Math.max(0, Number(e.target.value) || 0),
                                  }
                                : x,
                            ),
                          )
                        }
                      />
                      <button
                        type="button"
                        className="qty-btn"
                        title="Retirer cette déclinaison"
                        onClick={() => setDecl(decl.filter((_, j) => j !== i))}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  ))}

                  <button
                    type="button"
                    className="btn btn--ghost"
                    style={{ marginTop: 6 }}
                    onClick={() =>
                      setDecl([...decl, { valeur: "", sku: "", prixEuro: "", stock: 0, photo: "" }])
                    }
                  >
                    <Icon name="plus" /> Ajouter une déclinaison
                  </button>

                  <p className="row__s" style={{ whiteSpace: "normal", marginTop: 6 }}>
                    {decl.length === 0
                      ? "Sans déclinaison, le produit garde le stock unique saisi ci-dessus."
                      : "Prix et SKU sont facultatifs : vides, la déclinaison reprend ceux du produit. Retirer une ligne l'archive — son historique de stock est conservé."}
                  </p>
                </>
              )}
            </div>

            {/* Ligne 4 : Emplacement en atelier & Poids pour expédition */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="field">
                <label className="field__label">Emplacement atelier / entrepôt</label>
                <input
                  type="text"
                  className="input"
                  placeholder="Ex: Étagère B-02, Bac 4"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                />
                <span className="field-hint">Affiché en étape 1 lors du picking commande.</span>
              </div>

              <div className="field">
                <label className="field__label">Poids unitaire (grammes)</label>
                <input
                  type="text"
                  inputMode="numeric"
                  className="input font-mono"
                  placeholder="Ex: 350"
                  value={weightGrams}
                  onChange={(e) => setWeightGrams(e.target.value)}
                />
                <span className="field-hint">Aide au choix du timbre / Colissimo.</span>
              </div>
            </div>

            {/* Ligne 5 : Couleur(s) & Matière du produit */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="field">
                <label className="field__label">Couleur(s)</label>
                <input
                  type="text"
                  className="input"
                  placeholder="Ex: Noir mat, Doré, Bleu / Or..."
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                />
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                  {["Noir", "Blanc", "Bleu", "Rouge", "Vert", "Doré", "Argenté", "Rose", "Naturel"].map(
                    (c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setColor(color ? `${color}, ${c}` : c)}
                        style={{
                          background: "var(--card-2)",
                          border: "1px dashed var(--rule)",
                          borderRadius: 6,
                          padding: "1px 6px",
                          fontSize: 11,
                          color: "var(--ink)",
                          cursor: "pointer",
                        }}
                      >
                        + {c}
                      </button>
                    ),
                  )}
                </div>
              </div>

              <div className="field">
                <label className="field__label">Matière / Matériau</label>
                <input
                  type="text"
                  className="input"
                  placeholder="Ex: Céramique émaillée, Cuir végane, Coton..."
                  value={material}
                  onChange={(e) => setMaterial(e.target.value)}
                />
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                  {[
                    "Céramique",
                    "Coton bio",
                    "Acier inox",
                    "Cuir végane",
                    "Bois",
                    "Résine",
                    "Papier recyclé",
                    "Vinyle",
                  ].map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMaterial(material ? `${material}, ${m}` : m)}
                      style={{
                        background: "var(--card-2)",
                        border: "1px dashed var(--rule)",
                        borderRadius: 6,
                        padding: "1px 6px",
                        fontSize: 11,
                        color: "var(--ink)",
                        cursor: "pointer",
                      }}
                    >
                      + {m}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Ligne 6 : Emballage recommandé par défaut */}
            <div className="field">
              <label className="field__label">Consommable / Emballage recommandé</label>
              <select
                className="input"
                value={defaultConsumableId}
                onChange={(e) => setDefaultConsumableId(e.target.value)}
              >
                <option value="">-- Aucun (sélection manuelle à la commande) --</option>
                {consumables.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.stock} dispo)
                  </option>
                ))}
              </select>
              <span className="field-hint">
                Sera pré-sélectionné automatiquement en Étape 2 de l'exécution de commande.
              </span>
            </div>

            {/* Ligne 6 : Tags & Thématiques avec suggestions */}
            <div className="field">
              <label className="field__label">
                Tags & Thématiques (Univers, Matière, Type, Goodie...)
              </label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="text"
                  className="input"
                  placeholder="Ex: Chat, Anime, Japon, Céramique, Goodie... (Entrée ou virgule)"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addTag(tagInput);
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  onClick={() => addTag(tagInput)}
                  disabled={!tagInput.trim()}
                >
                  <Icon name="plus" /> Ajouter
                </button>
              </div>

              {/* Tags actuellement ajoutés */}
              {tags.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                  {tags.map((t) => (
                    <span
                      key={t}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        background: "color-mix(in srgb, var(--accent) 15%, var(--card))",
                        border: "1px solid color-mix(in srgb, var(--accent) 30%, var(--rule))",
                        color: "var(--ink)",
                        fontSize: 12,
                        padding: "3px 8px",
                        borderRadius: 8,
                        fontWeight: 600,
                      }}
                    >
                      🏷️ {t}
                      <button
                        type="button"
                        onClick={() => removeTag(t)}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: 0,
                          color: "var(--muted)",
                          fontSize: 12,
                          lineHeight: 1,
                        }}
                        title="Supprimer ce tag"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* Suggestions de tags existants dans le catalogue */}
              {existingTags.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <span style={{ fontSize: 11.5, color: "var(--muted)", display: "block", marginBottom: 4 }}>
                    💡 Tags déjà utilisés dans votre boutique (cliquez pour ajouter) :
                  </span>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {existingTags
                      .filter((et) => !tags.some((t) => t.toLowerCase() === et.name.toLowerCase()))
                      .slice(0, 10)
                      .map((et) => (
                        <button
                          key={et.name}
                          type="button"
                          onClick={() => addTag(et.name)}
                          style={{
                            background: "var(--card-2)",
                            border: "1px dashed var(--rule)",
                            borderRadius: 6,
                            padding: "2px 7px",
                            fontSize: 11,
                            color: "var(--ink)",
                            cursor: "pointer",
                          }}
                        >
                          + {et.name} ({et.count})
                        </button>
                      ))}
                  </div>
                </div>
              )}
              <span className="field-hint">
                Les tags permettent au moteur de recommander automatiquement le bon cadeau (goodie) en affinité avec le panier du client !
              </span>
            </div>

            {/* Ligne 7 : URL Image & Description */}
            <div className="field">
              <label className="field__label">URL de l'image (optionnel)</label>
              <input
                type="url"
                className="input"
                placeholder="https://images.unsplash.com/..."
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
              />
            </div>

            <div className="field">
              <label className="field__label">Description / Notes</label>
              <textarea
                className="input"
                rows={2}
                placeholder="Spécifications, composition, notes de préparation..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>

          <div className="modal-foot">
            {isEditing && (
              <button
                type="button"
                className="btn btn--stop"
                onClick={() => {
                  if (confirm(`Supprimer définitivement le produit « ${product?.title ?? ""} » ?`)) {
                    deleteMutation.mutate();
                  }
                }}
                disabled={deleteMutation.isPending}
              >
                Supprimer
              </button>
            )}

            <div className="modal-foot__right">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Annuler
              </button>
              <button
                type="submit"
                className="btn btn--primary"
                disabled={saveMutation.isPending || !sku.trim() || !title.trim()}
              >
                {saveMutation.isPending ? "Enregistrement…" : isEditing ? "Enregistrer" : "Créer le produit"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
