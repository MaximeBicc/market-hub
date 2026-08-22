import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ConsumableItem } from "../lib/api.js";
import { Icon } from "./Icon.js";
import { toast } from "./Toast.js";

interface ConsumableModalProps {
  consumable?: ConsumableItem | null;
  onClose: () => void;
  onSuccess?: () => void;
}

/** Nettoie et convertit une saisie utilisateur en nombre valide */
function parseNumberInput(val: string | number | undefined): number {
  if (val === undefined || val === null || val === "") return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const cleaned = String(val).replace(",", ".").trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

export function ConsumableModal({ consumable, onClose, onSuccess }: ConsumableModalProps) {
  const qc = useQueryClient();
  const isEditing = Boolean(consumable);

  const [name, setName] = useState(consumable?.name ?? "");
  const [category, setCategory] = useState<string>(consumable?.category ?? "envelope");
  const [stock, setStock] = useState<number>(consumable?.stock ?? 50);
  const [minAlert, setMinAlert] = useState<number>(consumable?.minAlert ?? 10);
  const [unitCostEuro, setUnitCostEuro] = useState<string>(
    consumable?.unitCost ? (consumable.unitCost / 100).toFixed(2) : "0.20",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: async () => {
      setErrorMsg(null);
      const cleanName = name.trim();
      if (!cleanName) {
        throw new Error("La désignation de la fourniture est requise.");
      }

      const payload = {
        id: consumable?.id,
        name: cleanName,
        category,
        stock: Math.max(0, Number(stock) || 0),
        minAlert: Math.max(1, Number(minAlert) || 1),
        unitCost: unitCostEuro.trim() ? Math.max(0, Math.round(parseNumberInput(unitCostEuro) * 100)) : 0,
      };
      return api.post<{ ok: boolean; id: string }>("/consumables", payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["consumables"] });
      toast(isEditing ? "Consommable mis à jour !" : "Nouveau consommable ajouté !");
      onSuccess?.();
      onClose();
    },
    onError: (err: any) => {
      setErrorMsg(err?.message || "Impossible d'enregistrer le consommable.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!consumable?.id) return;
      return api.delete(`/consumables/${consumable.id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["consumables"] });
      toast("Consommable supprimé");
      onClose();
    },
    onError: (err: any) => {
      setErrorMsg(err?.message || "Impossible de supprimer le consommable.");
    },
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: 540 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-badge-row">
              <span className="mono-badge mono-badge--small">
                <Icon name="mail" />
              </span>
              <span className="modal-platform">Fournitures d'emballage</span>
            </div>
            <h2 className="modal-title">
              {consumable ? `Modifier « ${consumable.name} »` : "Ajouter un consommable d'emballage"}
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

            <div className="field">
              <label className="field__label">
                Désignation de la fourniture <span style={{ color: "var(--stop)" }}>*</span>
              </label>
              <input
                type="text"
                className="input"
                placeholder="Ex: Enveloppe Bulle M (18x26 cm)"
                required
                autoFocus={!isEditing}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="field">
              <label className="field__label">Catégorie</label>
              <select
                className="input"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="envelope">✉️ Enveloppe (Bulle, Kraft, Cartonné)</option>
                <option value="box">📦 Boîte / Carton (Colissimo, Petit format)</option>
                <option value="label">🏷️ Étiquette d'expédition / Thermique</option>
                <option value="card">💳 Carte de remerciement / Visite</option>
                <option value="protection">🛡️ Calage & Protection (Kraft, Bulles, Adhésif)</option>
                <option value="other">📌 Autre accessoire</option>
              </select>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="field">
                <label className="field__label">Quantité en stock</label>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button
                    type="button"
                    className="qty-btn"
                    onClick={() => setStock((s) => Math.max(0, s - 5))}
                    title="-5"
                  >
                    -5
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
                    onClick={() => setStock((s) => s + 5)}
                    title="+5"
                  >
                    +5
                  </button>
                </div>
              </div>

              <div className="field">
                <label className="field__label">Seuil alerte réapprovisionnement</label>
                <input
                  type="number"
                  min="1"
                  className="input font-mono"
                  value={minAlert}
                  onChange={(e) => setMinAlert(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
            </div>

            <div className="field">
              <label className="field__label">Coût unitaire d'achat (€)</label>
              <input
                type="text"
                inputMode="decimal"
                className="input font-mono"
                placeholder="0.25"
                value={unitCostEuro}
                onChange={(e) => setUnitCostEuro(e.target.value)}
              />
              <span className="field-hint">
                Permet de calculer le coût réel d'emballage par commande.
              </span>
            </div>
          </div>

          <div className="modal-foot">
            {isEditing && (
              <button
                type="button"
                className="btn btn--stop"
                onClick={() => {
                  if (confirm(`Supprimer le consommable « ${consumable?.name ?? ""} » ?`)) {
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
                disabled={saveMutation.isPending || !name.trim()}
              >
                {saveMutation.isPending ? "Enregistrement…" : isEditing ? "Enregistrer" : "Ajouter le consommable"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
