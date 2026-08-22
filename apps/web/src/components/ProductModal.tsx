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
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Récupérer la liste des tags existants pour autocomplétion
  const { data: existingTagsData } = useQuery({
    queryKey: ["product-tags"],
    queryFn: () => api.get<{ tags: Array<{ name: string; count: number }> }>("/products/tags"),
  });
  const existingTags = existingTagsData?.tags ?? [];

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
        stock: Math.max(0, Number(stock) || 0),
        minAlert: Math.max(1, Number(minAlert) || 3),
        location: location.trim() || null,
        weightGrams: weightGrams.trim() ? Math.max(0, Math.round(parseNumberInput(weightGrams))) : null,
        defaultConsumableId: defaultConsumableId || null,
        color: color.trim() || null,
        material: material.trim() || null,
        images: imageUrl.trim() ? [imageUrl.trim()] : [],
        tags: tags.map((t) => t.trim()).filter(Boolean),
      };

      return api.post<{ ok: boolean; id: string; sku: string }>("/products", payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["product-tags"] });
      toast(isEditing ? "Produit mis à jour !" : "Nouveau produit ajouté au stock !");
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
