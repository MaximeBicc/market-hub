import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  money,
  when,
  type OrderDetailResponse,
  type OrderLineItem,
  type ConsumableItem,
  type FulfillOrderResponse,
} from "../lib/api.js";
import { Icon } from "./Icon.js";
import { PalmLoader } from "./PalmLoader.js";

interface FulfillmentModalProps {
  orderId: string;
  onClose: () => void;
  onSuccess?: () => void;
}

const CARRIER_OPTIONS = [
  { id: "laposte_suivie", name: "La Poste - Lettre Suivie", icon: "mail" as const, desc: "Format plat < 3 cm" },
  { id: "laposte_colissimo", name: "La Poste - Colissimo", icon: "truck" as const, desc: "Colis standard à domicile" },
  { id: "mondial_relay", name: "Mondial Relay", icon: "shops" as const, desc: "Livraison en point relais" },
  { id: "chronopost", name: "Chronopost / Express", icon: "sparkle" as const, desc: "Livraison express 24h" },
  { id: "platform_label", name: "Affranchi par la plateforme", icon: "tag" as const, desc: "Shopify / Etsy / eBay Shipping" },
];

interface FulfillmentModalProps {
  orderId: string;
  onClose: () => void;
  onSuccess?: () => void;
}

/**
 * Calcule la combinaison d'emballage optimale pour l'ensemble des articles de la commande.
 * Règle : tous les articles vont ensemble dans UN SEUL contenant adapté (enveloppe ou carton),
 * plus 1 étiquette d'expédition et 1 carte de remerciement pour le colis.
 */
function computeSmartPackagingPreset(
  lines: OrderLineItem[],
  consumables: ConsumableItem[],
): { preset: Record<string, number>; rationale: string; totalUnits: number; totalWeightGrams: number } {
  const preset: Record<string, number> = {};

  if (consumables.length === 0 || lines.length === 0) {
    return { preset, rationale: "", totalUnits: 0, totalWeightGrams: 0 };
  }

  const totalUnits = lines.reduce((s, l) => s + l.quantity, 0);
  const totalWeightGrams = lines.reduce(
    (s, l) => s + (l.weightGrams ? l.weightGrams * l.quantity : 80 * l.quantity),
    0,
  );

  // Vérifier si un des articles requiert expressément un carton
  const requiresBox = lines.some((l) => {
    if (l.weightGrams && l.weightGrams >= 300) return true;
    if (l.defaultConsumableId) {
      const match = consumables.find((c) => c.id === l.defaultConsumableId);
      return match?.category === "box";
    }
    return false;
  });

  const envS = consumables.find((c) => c.id === "c_env_bubble_s" || (c.category === "envelope" && c.name.toLowerCase().includes("s")));
  const envM = consumables.find((c) => c.id === "c_env_bubble_m" || (c.category === "envelope" && c.name.toLowerCase().includes("m")));
  const envL = consumables.find((c) => c.id === "c_env_bubble_l" || (c.category === "envelope" && c.name.toLowerCase().includes("l")));
  const anyEnv = envM || envS || envL || consumables.find((c) => c.category === "envelope");

  const boxS = consumables.find((c) => c.id === "c_box_colissimo_s" || (c.category === "box" && c.name.toLowerCase().includes("s")));
  const boxM = consumables.find((c) => c.id === "c_box_colissimo_m" || (c.category === "box" && c.name.toLowerCase().includes("m")));
  const anyBox = boxS || boxM || consumables.find((c) => c.category === "box");

  let chosenContainer: ConsumableItem | undefined;
  let rationale = "";

  if (requiresBox || totalWeightGrams > 500 || totalUnits >= 5) {
    // Cas Carton
    if (totalUnits >= 3 || totalWeightGrams > 750) {
      chosenContainer = boxM || boxS || anyBox || anyEnv;
      rationale = `Carton M adapté pour regrouper vos ${totalUnits} articles (~${totalWeightGrams}g).`;
    } else {
      chosenContainer = boxS || boxM || anyBox || anyEnv;
      rationale = `Carton S adapté pour regrouper vos ${totalUnits} article(s) dont produit volumineux (~${totalWeightGrams}g).`;
    }
    // Ajouter 1 calage kraft pour le carton
    const kraft = consumables.find((c) => c.id === "c_paper_kraft" || c.category === "protection");
    if (kraft && kraft.stock > 0) {
      preset[kraft.id] = 1;
    }
  } else {
    // Cas Enveloppe unique combinée
    if (totalUnits === 1 && totalWeightGrams <= 100) {
      chosenContainer = envS || envM || anyEnv;
      rationale = `1 Enveloppe Bulle S suffit pour 1 article léger (~${totalWeightGrams}g).`;
    } else if (totalUnits <= 4 && totalWeightGrams <= 350) {
      chosenContainer = envM || envL || envS || anyEnv;
      rationale = `1 Enveloppe Bulle M regroupe vos ${totalUnits} articles ensemble dans le même colis (~${totalWeightGrams}g).`;
    } else {
      chosenContainer = envL || envM || boxS || anyEnv;
      rationale = `1 Enveloppe Bulle L grand format regroupe vos ${totalUnits} articles (~${totalWeightGrams}g).`;
    }
  }

  // 1 seul contenant principal
  if (chosenContainer && chosenContainer.stock > 0) {
    preset[chosenContainer.id] = 1;
  }

  // 1 seule étiquette d'expédition par colis
  const label = consumables.find((c) => c.category === "label" && c.stock > 0);
  if (label) preset[label.id] = 1;

  // 1 seule carte de remerciement par colis
  const card = consumables.find((c) => c.category === "card" && c.stock > 0);
  if (card) preset[card.id] = 1;

  return { preset, rationale, totalUnits, totalWeightGrams };
}

export function FulfillmentModal({ orderId, onClose, onSuccess }: FulfillmentModalProps) {
  const queryClient = useQueryClient();

  // Étape courante : 1 à 5
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);

  // État Étape 1 : Picking produits
  const [pickedItemIds, setPickedItemIds] = useState<Set<string>>(new Set());

  // État Étape 2 : Consommables sélectionnés & Cadeau
  const [selectedConsumables, setSelectedConsumables] = useState<Record<string, number>>({});
  const [consumablesReady, setConsumablesReady] = useState(false);
  const [packagingRationale, setPackagingRationale] = useState<string>("");
  const [selectedGiftId, setSelectedGiftId] = useState<string | null>(null);

  // État Étape 3 : Expédition & Étiquette
  const [carrier, setCarrier] = useState("La Poste - Lettre Suivie");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [notifyBuyer, setNotifyBuyer] = useState(true);
  const [shippingLabelUrl, setShippingLabelUrl] = useState<string>("");
  const [shippingLabelType, setShippingLabelType] = useState<string>("");
  const [labelFileName, setLabelFileName] = useState<string>("");
  const [isUploadingLabel, setIsUploadingLabel] = useState(false);
  const [isPrintingDirect, setIsPrintingDirect] = useState(false);
  const [printFeedback, setPrintFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  // État Étape 4 : Vérification
  const [sealedChecked, setSealedChecked] = useState(false);

  // État Étape 5 : Résultat de l'exécution
  const [result, setResult] = useState<FulfillOrderResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Récupération des détails de la commande
  const { data: orderData, isLoading: loadingOrder } = useQuery({
    queryKey: ["order-detail", orderId],
    queryFn: () => api.get<OrderDetailResponse>(`/orders/${orderId}`),
  });

  // Récupération des consommables
  const { data: consumablesData } = useQuery({
    queryKey: ["consumables"],
    queryFn: () => api.get<{ consumables: ConsumableItem[] }>("/consumables"),
  });

  // Récupération des suggestions de cadeaux (budget <= 2.5% du CA & tags affinitaires)
  const { data: giftData } = useQuery({
    queryKey: ["gift-suggestions", orderId],
    queryFn: () =>
      api.get<{
        orderTotal: number;
        maxBudget: number;
        orderTags: string[];
        suggestions: Array<{
          product: {
            id: string;
            sku: string;
            title: string;
            costPrice: number | null;
            priceAmount: number;
            stock: number;
            color: string | null;
            material: string | null;
            images: string[];
            tags: string[];
          };
          costPrice: number;
          percentOfOrder: number;
          commonTags: string[];
          materialMatch: boolean;
          matchingMaterial: string | null;
          score: number;
        }>;
      }>(`/orders/${orderId}/gift-suggestions`),
  });

  const giftSuggestions = giftData?.suggestions ?? [];
  const maxGiftBudget = giftData?.maxBudget ?? 0;

  // Pré-sélectionner le meilleur cadeau par défaut si suggestion disponible
  useEffect(() => {
    if (giftSuggestions.length > 0 && selectedGiftId === null && giftSuggestions[0]) {
      setSelectedGiftId(giftSuggestions[0].product.id);
    }
  }, [giftSuggestions, selectedGiftId]);

  const consumables = consumablesData?.consumables ?? [];
  const lines = orderData?.lines ?? [];
  const order = orderData?.order;

  // Synchroniser les informations de la commande si déjà renseignées
  useEffect(() => {
    if (order) {
      if (order.shippingCarrier) setCarrier(order.shippingCarrier);
      if (order.trackingNumber) setTrackingNumber(order.trackingNumber);
      if (order.shippingLabelUrl) {
        setShippingLabelUrl(order.shippingLabelUrl);
        setShippingLabelType(order.shippingLabelType || "scraped");
      }
    }
  }, [order]);

  // Pré-sélectionner intelligemment la combinaison d'emballage
  const applySmartPreset = () => {
    const { preset, rationale } = computeSmartPackagingPreset(lines, consumables);
    setSelectedConsumables(preset);
    setPackagingRationale(rationale);
  };

  useEffect(() => {
    if (consumables.length > 0 && lines.length > 0 && Object.keys(selectedConsumables).length === 0) {
      applySmartPreset();
    }
  }, [consumables, lines]);

  // Téléversement d'une étiquette (PDF ou Image)
  const handleLabelUpload = async (file: File) => {
    if (!file) return;
    setIsUploadingLabel(true);
    setLabelFileName(file.name);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        setShippingLabelUrl(dataUrl);
        setShippingLabelType("uploaded");
        await api.post(`/orders/${orderId}/shipping-label`, {
          shippingLabelUrl: dataUrl,
          shippingLabelType: "uploaded",
          trackingNumber: trackingNumber || undefined,
          carrier: carrier || undefined,
        });
        queryClient.invalidateQueries({ queryKey: ["order-detail", orderId] });
        setIsUploadingLabel(false);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error(err);
      setIsUploadingLabel(false);
    }
  };

  // Vérifier en temps réel la disponibilité du pont d'impression direct L100
  const { data: printBridgeStatus } = useQuery({
    queryKey: ["print-bridge-status"],
    queryFn: async () => {
      try {
        const res = await fetch("http://127.0.0.1:9123/health", { signal: AbortSignal.timeout(1000) });
        if (!res.ok) return { ok: false, os: "", printer: "", status: "offline" };
        return (await res.json()) as { ok: boolean; os: string; printer: string; status: string };
      } catch {
        return { ok: false, os: "", printer: "", status: "offline" };
      }
    },
    refetchInterval: 3000,
  });

  // Impression DIRECTE sans dialogue système (envoi brut à l'imprimante thermique)
  const printThermalLabel = async () => {
    if (!order) return;
    setIsPrintingDirect(true);
    setPrintFeedback(null);

    const trackingCodeClean = (trackingNumber || `DHL${Math.floor(1000000000 + Math.random() * 9000000000)}`).replace(/\s+/g, "");

    try {
      const response = await fetch("http://127.0.0.1:9123/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_path: shippingLabelUrl ? undefined : "DHL-eCommerce-Label-1-rotated.jpg",
          data_url: shippingLabelUrl || undefined,
          buyer_name: order.buyer ?? "M. Thomas Petit",
          order_ref: order.externalId,
          tracking_number: trackingCodeClean,
          shop_name: order.shopName,
          carrier: carrier || "DHL eCommerce",
        }),
      });

      const res = await response.json();
      if (res.ok) {
        setPrintFeedback({
          ok: true,
          message: `✓ Étiquette DHL imprimée avec succès sur L100 (${res.bytes_count} octets CPCL)`,
        });
      } else {
        throw new Error(res.error || "Erreur de communication avec l'imprimante.");
      }
    } catch (err: any) {
      setPrintFeedback({
        ok: false,
        message: err?.message || "Le pont d'impression direct n'a pas répondu. Vérifiez que 'pnpm run print-server' est bien actif.",
      });
    } finally {
      setIsPrintingDirect(false);
    }
  };

  // Télécharger le PDF A4 Paysage (mauvaise orientation) de test
  const downloadA4ColissimoTest = () => {
    // Crée un SVG au format exact A4 Paysage (297x210 mm @ 203 DPI = 1199x799 px)
    const svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1199 799" width="1199" height="799" style="background:#fff;">
        <rect x="40" y="30" width="1119" height="739" fill="none" stroke="#000" stroke-width="4"/>
        <rect x="40" y="30" width="1119" height="90" fill="#000"/>
        <text x="60" y="85" fill="#fff" font-family="Arial" font-size="28" font-weight="bold">LA POSTE | COLISSIMO FRANCE</text>
        <text x="760" y="85" fill="#fff" font-family="Arial" font-size="20">LIVRAISON DOMICILE SANS SIGNATURE</text>
        <line x1="40" y1="220" x2="1159" y2="220" stroke="#000" stroke-width="3"/>
        <line x1="600" y1="120" x2="600" y2="220" stroke="#000" stroke-width="3"/>
        <text x="60" y="160" fill="#000" font-family="Arial" font-size="18">ROUTAGE POSTAL :</text>
        <text x="60" y="195" fill="#000" font-family="Arial" font-size="24" font-weight="bold">FR - 75011 - HUB 04</text>
        <text x="630" y="155" fill="#000" font-family="Arial" font-size="18">POIDS BRUT : 0.350 KG</text>
        <text x="630" y="185" fill="#000" font-family="Arial" font-size="18">REF COMMANDE : ${order?.externalId ?? "#4892"}</text>
        <line x1="40" y1="460" x2="1159" y2="460" stroke="#000" stroke-width="3"/>
        <line x1="560" y1="220" x2="560" y2="460" stroke="#000" stroke-width="3"/>
        <text x="60" y="260" fill="#000" font-family="Arial" font-size="18" font-weight="bold">DESTINATAIRE :</text>
        <text x="60" y="295" fill="#000" font-family="Arial" font-size="24" font-weight="bold">${(order?.buyer ?? "M. Thomas Petit").toUpperCase()}</text>
        <text x="60" y="335" fill="#000" font-family="Arial" font-size="20">12 RUE DES LILAS - BATIMENT B</text>
        <text x="60" y="375" fill="#000" font-family="Arial" font-size="20">CODE PORTE 4B12 - 2EME ETAGE</text>
        <text x="60" y="415" fill="#000" font-family="Arial" font-size="24" font-weight="bold">75011 PARIS - FRANCE</text>
        <text x="590" y="260" fill="#000" font-family="Arial" font-size="18" font-weight="bold">EXPEDITEUR :</text>
        <text x="590" y="295" fill="#000" font-family="Arial" font-size="22" font-weight="bold">${(order?.shopName ?? "BOUTIQUE MARKET-HUB").toUpperCase()}</text>
        <text x="590" y="335" fill="#000" font-family="Arial" font-size="20">ATELIER VARIETY TOOLS</text>
        <text x="590" y="375" fill="#000" font-family="Arial" font-size="20">45 RUE DE LA REPUBLIQUE</text>
        <text x="590" y="415" fill="#000" font-family="Arial" font-size="22" font-weight="bold">69002 LYON - FRANCE</text>
        <rect x="120" y="490" width="960" height="180" fill="none" stroke="#000" stroke-width="1"/>
        <g fill="#000">
          <rect x="160" y="510" width="6" height="120"/>
          <rect x="180" y="510" width="12" height="120"/>
          <rect x="210" y="510" width="4" height="120"/>
          <rect x="230" y="510" width="18" height="120"/>
          <rect x="260" y="510" width="8" height="120"/>
          <rect x="280" y="510" width="14" height="120"/>
          <rect x="310" y="510" width="6" height="120"/>
          <rect x="330" y="510" width="16" height="120"/>
          <rect x="360" y="510" width="10" height="120"/>
          <rect x="390" y="510" width="6" height="120"/>
          <rect x="410" y="510" width="14" height="120"/>
          <rect x="440" y="510" width="8" height="120"/>
          <rect x="460" y="510" width="18" height="120"/>
          <rect x="495" y="510" width="10" height="120"/>
          <rect x="520" y="510" width="6" height="120"/>
          <rect x="540" y="510" width="16" height="120"/>
          <rect x="570" y="510" width="8" height="120"/>
          <rect x="590" y="510" width="14" height="120"/>
          <rect x="620" y="510" width="6" height="120"/>
          <rect x="640" y="510" width="18" height="120"/>
          <rect x="670" y="510" width="10" height="120"/>
          <rect x="700" y="510" width="8" height="120"/>
          <rect x="720" y="510" width="16" height="120"/>
          <rect x="750" y="510" width="6" height="120"/>
          <rect x="770" y="510" width="14" height="120"/>
          <rect x="800" y="510" width="8" height="120"/>
          <rect x="820" y="510" width="18" height="120"/>
          <rect x="850" y="510" width="10" height="120"/>
          <rect x="880" y="510" width="14" height="120"/>
          <rect x="910" y="510" width="6" height="120"/>
          <rect x="930" y="510" width="16" height="120"/>
          <rect x="960" y="510" width="8" height="120"/>
          <rect x="980" y="510" width="14" height="120"/>
          <rect x="1010" y="510" width="6" height="120"/>
        </g>
        <text x="440" y="660" fill="#000" font-family="monospace" font-size="26" font-weight="bold" letter-spacing="4">${(trackingNumber || "6A 1482 9204 8812")}</text>
        <text x="60" y="735" fill="#000" font-family="Arial" font-size="16">COLISSIMO LIVRAISON DIRECTE - PREUVE DE DEPOT ELECTRONIQUE - A4 PAYSAGE TEST</text>
      </svg>
    `;

    const blob = new Blob([svgContent], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `etiquette_colissimo_${order?.externalId ?? "test"}_A4.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Mutation pour exécuter la commande
  const fulfillMutation = useMutation({
    mutationFn: async () => {
      const consumablesPayload = Object.entries(selectedConsumables)
        .filter(([, qty]) => qty > 0)
        .map(([id, quantity]) => ({ id, quantity }));

      // Calculer l'URL de tracking automatique si transporteur La Poste
      let trackingUrl: string | undefined;
      if (trackingNumber.trim()) {
        const clean = trackingNumber.trim();
        if (carrier.toLowerCase().includes("poste") || carrier.toLowerCase().includes("colissimo")) {
          trackingUrl = `https://www.laposte.fr/outils/suivre-vos-envois?code=${encodeURIComponent(clean)}`;
        } else if (carrier.toLowerCase().includes("mondial")) {
          trackingUrl = `https://www.mondialrelay.fr/suivi-de-colis?numeroExpedition=${encodeURIComponent(clean)}`;
        }
      }

      return api.post<FulfillOrderResponse>(`/orders/${orderId}/fulfill`, {
        carrier,
        trackingNumber: trackingNumber.trim() || undefined,
        trackingUrl,
        consumables: consumablesPayload,
        giftProductId: selectedGiftId || undefined,
        decrementProductStock: true,
        notifyBuyer,
      });
    },
    onSuccess: (data) => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["order-detail", orderId] });
      queryClient.invalidateQueries({ queryKey: ["consumables"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
      onSuccess?.();
    },
    onError: (err: Error) => {
      setErrorMsg(err.message || "Une erreur est survenue lors de la finalisation.");
    },
  });

  // Basculer l'état coché d'un article produit
  const toggleItemPicked = (id: string) => {
    setPickedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pickAll = () => {
    setPickedItemIds(new Set(lines.map((l) => l.id)));
  };

  // Ajuster la quantité d'un consommable
  const setConsumableQty = (id: string, delta: number) => {
    setSelectedConsumables((prev) => {
      const current = prev[id] ?? 0;
      const next = Math.max(0, current + delta);
      return { ...prev, [id]: next };
    });
  };

  const allItemsPicked = lines.length > 0 && lines.every((l) => pickedItemIds.has(l.id));
  const totalPickedCount = pickedItemIds.size;
  const totalItemsCount = lines.length;

  const selectedConsumablesList = consumables.filter(
    (c) => (selectedConsumables[c.id] ?? 0) > 0,
  );

  if (loadingOrder || !order) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-card modal-card--loading" onClick={(e) => e.stopPropagation()}>
          <PalmLoader compact label="Chargement de la commande…" />
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {/* --- En-tête de la modale --- */}
        <div className="modal-head">
          <div className="modal-head__info">
            <div className="modal-badge-row">
              <span className="mono-badge mono-badge--small">
                {order.shopName.slice(0, 2).toUpperCase()}
              </span>
              <span className="modal-platform">{order.platform}</span>
              <span className="modal-order-num">{order.externalId}</span>
              <span className="modal-date">· {when(order.placedAt)}</span>
            </div>
            <h2 className="modal-title">
              Préparation de commande · {order.buyer ?? "Acheteur"}
            </h2>
          </div>
          <button className="modal-close" onClick={onClose} title="Fermer">
            <Icon name="close" />
          </button>
        </div>

        {/* --- Stepper visuel 5 étapes --- */}
        <div className="stepper">
          {[
            { n: 1, label: "1. Produits", icon: "box" as const },
            { n: 2, label: "2. Consommables", icon: "mail" as const },
            { n: 3, label: "3. Expédition", icon: "truck" as const },
            { n: 4, label: "4. Vérification", icon: "checkCircle" as const },
            { n: 5, label: "5. Confirmation", icon: "sparkle" as const },
          ].map((s) => {
            const isDone = step > s.n || (result !== null && s.n === 5);
            const isCurrent = step === s.n && result === null;
            return (
              <button
                key={s.n}
                type="button"
                className={`step-btn ${isCurrent ? "step-btn--active" : ""} ${
                  isDone ? "step-btn--done" : ""
                }`}
                onClick={() => {
                  // Permet de naviguer vers une étape précédente librement
                  if (s.n < step) setStep(s.n as never);
                }}
                disabled={s.n > step || result !== null}
              >
                <span className="step-btn__bubble">
                  {isDone ? <Icon name="check" /> : s.n}
                </span>
                <span className="step-btn__label">{s.label}</span>
              </button>
            );
          })}
        </div>

        {/* --- Corps de la modale selon l'étape --- */}
        <div className="modal-body">
          {/* ========================================================
              ÉTAPE 1 : RÉCUPÉRATION DES PRODUITS (PICKING)
             ======================================================== */}
          {step === 1 && (
            <div className="step-content">
              <div className="step-intro">
                <div>
                  <h3 className="step-heading">Étape 1 : Récupération des articles</h3>
                  <p className="step-desc">
                    Munissez-vous des articles dans votre stock et cochez chaque
                    ligne pour confirmer la préparation.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  onClick={pickAll}
                >
                  <Icon name="check" /> Tout cocher
                </button>
              </div>

              {/* Barre de progression du picking */}
              <div className="picking-bar">
                <div
                  className="picking-bar__fill"
                  style={{
                    width: `${lines.length > 0 ? (totalPickedCount / totalItemsCount) * 100 : 0}%`,
                  }}
                />
                <span className="picking-bar__text">
                  {totalPickedCount} / {totalItemsCount} article{totalItemsCount > 1 ? "s" : ""}{" "}
                  récupéré{totalPickedCount > 1 ? "s" : ""}
                </span>
              </div>

              {/* Liste des lignes de commande */}
              <div className="picking-list">
                {lines.map((line) => {
                  const isPicked = pickedItemIds.has(line.id);
                  return (
                    <label
                      key={line.id}
                      className={`picking-item ${isPicked ? "picking-item--checked" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={isPicked}
                        onChange={() => toggleItemPicked(line.id)}
                        className="picking-item__checkbox"
                      />
                      {line.imageUrl ? (
                        <img src={line.imageUrl} alt="" className="picking-item__thumb" />
                      ) : (
                        <div className="picking-item__thumb-ph">
                          <Icon name="box" />
                        </div>
                      )}
                      <div className="picking-item__info">
                        <div className="picking-item__title">{line.title}</div>
                        <div className="picking-item__meta">
                          {line.sku && (
                            <span className="sku-badge">
                              <Icon name="tag" /> SKU : {line.sku}
                            </span>
                          )}
                          {line.location && (
                            <span className="sku-badge" style={{ color: "var(--accent)" }}>
                              📍 {line.location}
                            </span>
                          )}
                          {line.color && (
                            <span className="sku-badge">
                              🎨 {line.color}
                            </span>
                          )}
                          {line.material && (
                            <span className="sku-badge">
                              🧶 {line.material}
                            </span>
                          )}
                          {line.weightGrams && (
                            <span className="sku-badge">
                              ⚖️ {line.weightGrams}g
                            </span>
                          )}
                          {line.currentStock !== null && (
                            <span
                              className={`stock-indicator ${
                                line.currentStock <= 2 ? "stock-indicator--low" : ""
                              }`}
                            >
                              Stock actuel : {line.currentStock}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="picking-item__qty-box">
                        <span className="qty-tag">x{line.quantity}</span>
                        <span className="line-price">
                          {money(line.unitPriceAmount * line.quantity, line.unitPriceCurrency)}
                        </span>
                      </div>
                    </label>
                  );
                })}
              </div>

              {!allItemsPicked && (
                <div className="banner banner--warn">
                  <span className="banner__t">Articles en attente</span>
                  <span className="banner__b">
                    Veuillez cocher tous les articles récupérés avant de passer à
                    l'étape d'emballage.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* ========================================================
              ÉTAPE 2 : RÉCUPÉRATION DES CONSOMMABLES (PACKAGING)
             ======================================================== */}
          {step === 2 && (
            <div className="step-content">
              <div className="step-intro">
                <div>
                  <h3 className="step-heading">Étape 2 : Matériel & Consommables d'emballage</h3>
                  <p className="step-desc">
                    Combinaison automatique de vos articles dans 1 seul colis adapté.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  onClick={applySmartPreset}
                  title="Réappliquer la combinaison d'emballage optimale calculée"
                >
                  <Icon name="sparkle" /> Suggérer l'emballage
                </button>
              </div>

              {/* Bandeau de combinaison intelligente de colis */}
              {packagingRationale && (
                <div className="smart-packaging-banner">
                  <div className="smart-packaging-banner__icon">💡</div>
                  <div className="smart-packaging-banner__text">
                    <strong>Combinaison de colis optimisée :</strong>
                    <p>{packagingRationale}</p>
                    <span>
                      Tous les articles de la commande sont regroupés dans 1 seul contenant avec 1
                      étiquette et 1 carte de remerciement. Vous pouvez ajuster les quantités ci-dessous.
                    </span>
                  </div>
                </div>
              )}

              {/* Section Cadeau Client Offert (Budget <= 2.5% du CA & Affinité Tags) */}
              {giftSuggestions.length > 0 ? (
                <div className="gift-suggestion-box">
                  <div className="gift-suggestion-box__head">
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 22 }}>🎁</span>
                      <div>
                        <strong style={{ fontSize: 13.5, color: "var(--ink)" }}>
                          Cadeau / Goodie client (Budget &le; 2.5% du CA)
                        </strong>
                        <span style={{ fontSize: 12, color: "var(--muted)", display: "block" }}>
                          Budget disponible : <b>{money(maxGiftBudget)} max</b> (sur une commande de {money(order.amount, order.currency)})
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      className={`btn btn--small ${selectedGiftId ? "btn--primary" : "btn--ghost"}`}
                      onClick={() => {
                        if (selectedGiftId) setSelectedGiftId(null);
                        else if (giftSuggestions[0]) setSelectedGiftId(giftSuggestions[0].product.id);
                      }}
                    >
                      {selectedGiftId ? "✓ Cadeau offert inclus" : "➕ Ajouter un cadeau"}
                    </button>
                  </div>

                  {selectedGiftId && (
                    <div className="gift-selected-card">
                      {(() => {
                        const currentGift =
                          giftSuggestions.find((g) => g.product.id === selectedGiftId) || giftSuggestions[0];
                        if (!currentGift) return null;
                        const p = currentGift.product;
                        return (
                          <div style={{ display: "grid", gap: 8 }}>
                            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                              {p.images?.[0] ? (
                                <img
                                  src={p.images[0]}
                                  alt=""
                                  style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover", flex: "none" }}
                                />
                              ) : (
                                <span className="mono-badge">🎁</span>
                              )}
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{p.title}</div>
                                <div
                                  style={{
                                    fontSize: 12,
                                    color: "var(--muted)",
                                    display: "flex",
                                    gap: 8,
                                    flexWrap: "wrap",
                                    marginTop: 2,
                                  }}
                                >
                                  <span>
                                    SKU : <b className="font-mono">{p.sku}</b>
                                  </span>
                                  <span>
                                    Coût d'achat : <b style={{ color: "var(--ok)" }}>{money(currentGift.costPrice)}</b> ({currentGift.percentOfOrder}% du CA)
                                  </span>
                                  <span>
                                    Stock : <b>{p.stock} dispo</b>
                                  </span>
                                </div>
                              </div>
                            </div>

                            {/* Affinités Tags & Matière */}
                            {(currentGift.commonTags.length > 0 || currentGift.materialMatch) && (
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 11.5 }}>
                                <span style={{ color: "var(--accent)", fontWeight: 600 }}>🎯 En affinité avec la commande :</span>
                                {currentGift.commonTags.map((t) => (
                                  <span key={t} className="selected-tag" style={{ fontSize: 11, padding: "1px 6px" }}>
                                    🏷️ {t}
                                  </span>
                                ))}
                                {currentGift.matchingMaterial && (
                                  <span className="selected-tag" style={{ fontSize: 11, padding: "1px 6px" }}>
                                    🧶 Matière : {currentGift.matchingMaterial}
                                  </span>
                                )}
                              </div>
                            )}

                            {/* Sélecteur alternatif si plusieurs cadeaux sont éligibles */}
                            {giftSuggestions.length > 1 && (
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                                <label style={{ fontSize: 11.5, color: "var(--muted)" }}>Choisir un autre cadeau :</label>
                                <select
                                  className="input"
                                  style={{ padding: "4px 8px", fontSize: 12, height: "auto" }}
                                  value={selectedGiftId}
                                  onChange={(e) => setSelectedGiftId(e.target.value)}
                                >
                                  {giftSuggestions.map((g) => (
                                    <option key={g.product.id} value={g.product.id}>
                                      {g.product.title} (Coût : {money(g.costPrice)} — {g.percentOfOrder}%)
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              ) : null}

              <div className="consumables-grid">
                {consumables.map((c) => {
                  const qty = selectedConsumables[c.id] ?? 0;
                  const isSelected = qty > 0;
                  const isLow = c.stock <= c.minAlert;
                  const isOut = c.stock === 0;

                  return (
                    <div
                      key={c.id}
                      className={`consumable-card ${isSelected ? "consumable-card--selected" : ""}`}
                    >
                      <div className="consumable-card__main">
                        <span className="consumable-category">{c.category}</span>
                        <h4 className="consumable-name">{c.name}</h4>
                        <div className="consumable-stock-line">
                          <span
                            className={`stock-pill ${
                              isOut
                                ? "stock-pill--out"
                                : isLow
                                ? "stock-pill--low"
                                : "stock-pill--ok"
                            }`}
                          >
                            Stock dispo : {c.stock}
                          </span>
                          {c.unitCost ? (
                            <span className="cost-pill">~{money(c.unitCost)} / u</span>
                          ) : null}
                        </div>
                      </div>

                      <div className="qty-control">
                        <button
                          type="button"
                          className="qty-btn"
                          onClick={() => setConsumableQty(c.id, -1)}
                          disabled={qty === 0}
                          title="Diminuer"
                        >
                          <Icon name="minus" />
                        </button>
                        <span className="qty-val">{qty}</span>
                        <button
                          type="button"
                          className="qty-btn"
                          onClick={() => setConsumableQty(c.id, 1)}
                          title="Augmenter"
                        >
                          <Icon name="plus" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Récapitulatif rapide des fournitures choisies */}
              <div className="consumables-summary">
                <span className="summary-title">Fournitures retenues :</span>
                {selectedConsumablesList.length === 0 ? (
                  <span className="muted">Aucun consommable sélectionné</span>
                ) : (
                  <div className="consumables-pill-list">
                    {selectedConsumablesList.map((c) => (
                      <span key={c.id} className="selected-tag">
                        {c.name} <b>x{selectedConsumables[c.id]}</b>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <label className="checkbox-confirm">
                <input
                  type="checkbox"
                  checked={consumablesReady}
                  onChange={(e) => setConsumablesReady(e.target.checked)}
                />
                <span>J'ai rassemblé les fournitures et emballages nécessaires</span>
              </label>
            </div>
          )}

          {/* ========================================================
              ÉTAPE 3 : EXPÉDITION & AFFRANCHISSEMENT (SHIPPING)
             ======================================================== */}
          {step === 3 && (
            <div className="step-content">
              <div className="step-intro">
                <div>
                  <h3 className="step-heading">Étape 3 : Affranchissement & Suivi</h3>
                  <p className="step-desc">
                    Choisissez le transporteur et renseignez le numéro de suivi pour
                    l'acheteur.
                  </p>
                </div>
              </div>

              {/* Carte Étiquette d'expédition & Impression thermique L100 */}
              <div className="shipping-label-card">
                <div className="shipping-label-card__head">
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 24 }}>🏷️</span>
                    <div>
                      <strong style={{ fontSize: 14 }}>Étiquette d'expédition (Format L100 - 100x150 mm)</strong>
                      <span style={{ fontSize: 12, color: "var(--muted)", display: "block" }}>
                        {shippingLabelUrl ? (
                          shippingLabelType === "scraped" ? (
                            <span style={{ color: "var(--ok)", fontWeight: 600 }}>
                              ✓ Étiquette synchronisée depuis {order.shopName} ({order.platform})
                            </span>
                          ) : (
                            <span style={{ color: "var(--accent)", fontWeight: 600 }}>
                              ✓ Étiquette téléversée : {labelFileName || "Fichier prêt"}
                            </span>
                          )
                        ) : (
                          <span>
                            Aucune étiquette importée — Vous pouvez téléverser votre PDF/image ou générer le format standard.
                          </span>
                        )}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <a
                      href="/DHL-eCommerce-Label-1-rotated.jpg"
                      download="DHL-eCommerce-Label-1-rotated.jpg"
                      className="btn btn--small btn--ghost"
                      title="Télécharger l'étiquette DHL eCommerce de test"
                    >
                      📥 Télécharger Étiquette DHL
                    </a>

                    <label className="btn btn--small btn--ghost" style={{ cursor: "pointer", margin: 0 }}>
                      <Icon name="upload" /> {shippingLabelUrl ? "Remplacer l'étiquette" : "Téléverser étiquette"}
                      <input
                        type="file"
                        accept=".pdf,image/*"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleLabelUpload(file);
                        }}
                      />
                    </label>

                    <button
                      type="button"
                      className="btn btn--small btn--primary"
                      onClick={printThermalLabel}
                      disabled={isPrintingDirect}
                      title="Envoie directement l'ordre d'impression à votre imprimante thermique L100"
                    >
                      <Icon name="printer" /> {isPrintingDirect ? "Impression en cours..." : "Imprimer l'étiquette (L100)"}
                    </button>
                  </div>
                </div>

                {/* Feedback d'impression en temps réel */}
                {printFeedback && (
                  <div
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      fontSize: 12.5,
                      fontWeight: 600,
                      background: printFeedback.ok ? "rgba(16, 185, 129, 0.12)" : "rgba(239, 68, 68, 0.12)",
                      color: printFeedback.ok ? "var(--ok)" : "var(--error)",
                      border: `1px solid ${printFeedback.ok ? "var(--ok)" : "var(--error)"}`,
                    }}
                  >
                    {printFeedback.message}
                  </div>
                )}

                {/* Info bridge USB Linux / Windows */}
                <div className="shipping-label-card__hint" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <span>
                    💡 <b>Impression USB directe :</b> Protocole CPCL sans boîte de dialogue — Détection automatique ({printBridgeStatus?.os || "Linux / Windows"}).
                  </span>
                  {printBridgeStatus?.ok ? (
                    <span style={{ fontSize: 11, color: "var(--ok)", background: "rgba(16, 185, 129, 0.15)", padding: "2px 8px", borderRadius: 6, fontWeight: 700 }}>
                      ● Serveur L100 en ligne ({printBridgeStatus.printer})
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, color: "#d97706", background: "rgba(245, 158, 11, 0.15)", padding: "2px 8px", borderRadius: 6, fontWeight: 700 }}>
                      ○ Serveur hors-ligne (<code>pnpm run print-server</code>)
                    </span>
                  )}
                </div>
              </div>

              {/* Raccourcis d'achat d'affranchissement */}
              <div className="postage-shortcuts">
                <div className="shortcut-box">
                  <span className="shortcut-box__title">Besoin d'acheter un timbre ou affranchissement ?</span>
                  <p className="shortcut-box__desc">
                    Générez directement votre affranchissement en ligne sur La Poste Pro
                    ou la boutique :
                  </p>
                  <div className="shortcut-box__actions">
                    <a
                      href="https://boutique.laposte.fr/affranchissement-en-ligne"
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn--small"
                    >
                      <Icon name="link" /> La Poste - Lettre Suivie
                    </a>
                    <a
                      href="https://www.laposte.fr/colissimo-en-ligne"
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn--small"
                    >
                      <Icon name="link" /> Colissimo en ligne
                    </a>
                  </div>
                </div>
              </div>

              {/* Sélection du transporteur */}
              <div className="field">
                <label>Transporteur :</label>
                <div className="carrier-grid">
                  {CARRIER_OPTIONS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`carrier-card ${carrier === c.name ? "carrier-card--active" : ""}`}
                      onClick={() => setCarrier(c.name)}
                    >
                      <div className="carrier-card__icon">
                        <Icon name={c.icon} />
                      </div>
                      <div>
                        <div className="carrier-card__name">{c.name}</div>
                        <div className="carrier-card__desc">{c.desc}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Champ numéro de suivi */}
              <div className="field">
                <label htmlFor="trackingInput">Numéro de suivi du colis / lettre :</label>
                <div className="tracking-input-wrapper">
                  <input
                    id="trackingInput"
                    type="text"
                    className="input font-mono"
                    placeholder="Ex: 6A12345678901 ou 1L123456789"
                    value={trackingNumber}
                    onChange={(e) => setTrackingNumber(e.target.value)}
                  />
                  {trackingNumber && (
                    <button
                      type="button"
                      className="btn btn--small btn--ghost"
                      onClick={() => setTrackingNumber("")}
                    >
                      Effacer
                    </button>
                  )}
                </div>
                <span className="field-hint">
                  Le numéro de suivi sera transmis à la plateforme ({order.platform}) et
                  notifié au client.
                </span>
              </div>

              <label className="checkbox-confirm">
                <input
                  type="checkbox"
                  checked={notifyBuyer}
                  onChange={(e) => setNotifyBuyer(e.target.checked)}
                />
                <span>Notifier l'acheteur par notification / email avec le suivi</span>
              </label>
            </div>
          )}

          {/* ========================================================
              ÉTAPE 4 : VÉRIFICATION GLOBALE (QUALITY CHECK)
             ======================================================== */}
          {step === 4 && (
            <div className="step-content">
              <div className="step-intro">
                <div>
                  <h3 className="step-heading">Étape 4 : Contrôle final du colis</h3>
                  <p className="step-desc">
                    Vérifiez que tous les éléments sont réunis avant de sceller le
                    paquet et de coller l'étiquette.
                  </p>
                </div>
              </div>

              <div className="review-grid">
                {/* Carte 1 : Produits */}
                <div className="review-card">
                  <div className="review-card__head">
                    <Icon name="box" />
                    <h4>Articles emballés ({lines.length})</h4>
                  </div>
                  <ul className="review-list">
                    {lines.map((l) => (
                      <li key={l.id}>
                        <span className="item-title">{l.title}</span>
                        <span className="item-qty">x{l.quantity}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Carte 2 : Consommables */}
                <div className="review-card">
                  <div className="review-card__head">
                    <Icon name="mail" />
                    <h4>Consommables utilisés ({selectedConsumablesList.length})</h4>
                  </div>
                  <ul className="review-list">
                    {selectedConsumablesList.length > 0 ? (
                      selectedConsumablesList.map((c) => (
                        <li key={c.id}>
                          <span>{c.name}</span>
                          <span className="item-qty">x{selectedConsumables[c.id]}</span>
                        </li>
                      ))
                    ) : (
                      <li className="muted">Aucun consommable sélectionné</li>
                    )}
                  </ul>
                </div>

                {/* Carte 3 : Expédition */}
                <div className="review-card">
                  <div className="review-card__head">
                    <Icon name="truck" />
                    <h4>Mode d'expédition</h4>
                  </div>
                  <div className="review-meta-item">
                    <span className="review-label">Transporteur :</span>
                    <b>{carrier}</b>
                  </div>
                  <div className="review-meta-item">
                    <span className="review-label">Suivi :</span>
                    <b className="font-mono">{trackingNumber || "Sans numéro de suivi"}</b>
                  </div>
                </div>

                {/* Carte 4 : Destinataire */}
                <div className="review-card">
                  <div className="review-card__head">
                    <Icon name="shops" />
                    <h4>Destinataire & Boutique</h4>
                  </div>
                  <div className="review-meta-item">
                    <span className="review-label">Acheteur :</span>
                    <b>{order.buyer ?? "Inconnu"}</b>
                  </div>
                  <div className="review-meta-item">
                    <span className="review-label">Boutique :</span>
                    <b>
                      {order.shopName} ({order.platform})
                    </b>
                  </div>
                  <div className="review-meta-item">
                    <span className="review-label">Total :</span>
                    <b>{money(order.amount, order.currency)}</b>
                  </div>
                </div>

                {/* Carte 5 : Cadeau client offert (si sélectionné) */}
                {selectedGiftId && (() => {
                  const giftObj = giftSuggestions.find((g) => g.product.id === selectedGiftId);
                  return (
                    <div className="review-card" style={{ borderColor: "var(--accent)" }}>
                      <div className="review-card__head">
                        <span style={{ fontSize: 16 }}>🎁</span>
                        <h4>Cadeau offert au client</h4>
                      </div>
                      {giftObj ? (
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          {giftObj.product.images?.[0] && (
                            <img
                              src={giftObj.product.images[0]}
                              alt=""
                              style={{ width: 36, height: 36, borderRadius: 6, objectFit: "cover" }}
                            />
                          )}
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{giftObj.product.title}</div>
                            <span style={{ fontSize: 11.5, color: "var(--ok)", fontWeight: 600 }}>
                              Offert ({money(giftObj.costPrice)} — {giftObj.percentOfOrder}% du CA)
                            </span>
                          </div>
                        </div>
                      ) : (
                        <span>Cadeau personnalisé</span>
                      )}
                    </div>
                  );
                })()}
              </div>

              <label className="checkbox-confirm checkbox-confirm--highlight">
                <input
                  type="checkbox"
                  checked={sealedChecked}
                  onChange={(e) => setSealedChecked(e.target.checked)}
                />
                <b>
                  Je confirme que les articles sont correctement emballés, le colis
                  fermé et l'étiquette apposée.
                </b>
              </label>
            </div>
          )}

          {/* ========================================================
              ÉTAPE 5 : CONFIRMATION & CLÔTURE (STOCK DECREMENT)
             ======================================================== */}
          {step === 5 && (
            <div className="step-content">
              {result ? (
                <div className="success-screen">
                  <div className="success-screen__icon">
                    <Icon name="checkCircle" />
                  </div>
                  <h3 className="success-screen__title">Commande validée & expédiée !</h3>
                  <p className="success-screen__desc">
                    La commande <b>{order.externalId}</b> est marquée comme expédiée.
                    Les stocks de produits, consommables et cadeaux ont été décrémentés en
                    temps réel.
                  </p>

                  <div className="decremented-summary-box">
                    <div className="decremented-col">
                      <h4>📦 Produits décrémentés :</h4>
                      <ul>
                        {result.products.map((p, idx) => (
                          <li key={idx}>
                            {p.title} <b>- {p.quantity}</b>{" "}
                            {p.remainingStock !== null && (
                              <span className="muted">(Reste : {p.remainingStock})</span>
                            )}
                          </li>
                        ))}
                        {result.gift && (
                          <li style={{ color: "var(--accent)", fontWeight: 600 }}>
                            🎁 {result.gift.title} (Cadeau) <b>- 1</b>{" "}
                            <span className="muted">(Reste : {result.gift.remainingStock})</span>
                          </li>
                        )}
                      </ul>
                    </div>

                    <div className="decremented-col">
                      <h4>✉️ Consommables décrémentés :</h4>
                      <ul>
                        {result.consumables.map((c, idx) => (
                          <li key={idx}>
                            {c.name} <b>- {c.quantity}</b>{" "}
                            <span className="muted">(Reste : {c.remaining})</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="success-actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => window.print()}
                    >
                      <Icon name="printer" /> Imprimer le bon d'envoi
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={onClose}
                    >
                      Terminer & Retour aux commandes
                    </button>
                  </div>
                </div>
              ) : (
                <div className="confirmation-final-box">
                  <div className="step-intro">
                    <div>
                      <h3 className="step-heading">Étape 5 : Décrémentation des stocks & validation</h3>
                      <p className="step-desc">
                        En validant, le statut de la commande passera en <b>Expédiée</b>,
                        et les stocks suivants seront automatiquement mis à jour :
                      </p>
                    </div>
                  </div>

                  <div className="impact-grid">
                    <div className="impact-card">
                      <span className="impact-card__icon">📦</span>
                      <div className="impact-card__content">
                        <h4>Décrémentation Produits</h4>
                        <p>
                          {lines.reduce((s, l) => s + l.quantity, 0)} article(s) au total
                          décompté(s) de l'inventaire central et des annonces associées.
                        </p>
                      </div>
                    </div>

                    <div className="impact-card">
                      <span className="impact-card__icon">✉️</span>
                      <div className="impact-card__content">
                        <h4>Décrémentation Consommables</h4>
                        <p>
                          {selectedConsumablesList.length} type(s) de consommables
                          décomptés du stock d'emballage.
                        </p>
                      </div>
                    </div>

                    <div className="impact-card">
                      <span className="impact-card__icon">🚀</span>
                      <div className="impact-card__content">
                        <h4>Transmission Marketplace</h4>
                        <p>
                          Mise à jour du statut chez {order.platform} avec le transporteur{" "}
                          <b>{carrier}</b>.
                        </p>
                      </div>
                    </div>
                  </div>

                  {errorMsg && (
                    <div className="banner banner--stop">
                      <span className="banner__t">Erreur lors de la validation</span>
                      <span className="banner__b">{errorMsg}</span>
                    </div>
                  )}

                  <div className="final-action-container">
                    <button
                      type="button"
                      className="btn btn--primary btn--wide btn--large"
                      disabled={fulfillMutation.isPending}
                      onClick={() => fulfillMutation.mutate()}
                    >
                      {fulfillMutation.isPending ? (
                        <>Validation et mise à jour en cours…</>
                      ) : (
                        <>
                          <Icon name="sparkle" /> Confirmer l'emballage et clôturer la
                          commande
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* --- Pied de modale : Navigation entre étapes --- */}
        {result === null && (
          <div className="modal-foot">
            {step > 1 ? (
              <button
                type="button"
                className="btn"
                onClick={() => setStep((s) => (s - 1) as never)}
                disabled={fulfillMutation.isPending}
              >
                <Icon name="chevronLeft" /> Précédent
              </button>
            ) : (
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Annuler
              </button>
            )}

            <div className="modal-foot__right">
              {step === 1 && (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!allItemsPicked}
                  onClick={() => setStep(2)}
                >
                  Suivant : Consommables <Icon name="chevronRight" />
                </button>
              )}

              {step === 2 && (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setStep(3)}
                >
                  Suivant : Expédition <Icon name="chevronRight" />
                </button>
              )}

              {step === 3 && (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setStep(4)}
                >
                  Suivant : Vérification <Icon name="chevronRight" />
                </button>
              )}

              {step === 4 && (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!sealedChecked}
                  onClick={() => setStep(5)}
                >
                  Suivant : Clôture & Stocks <Icon name="chevronRight" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
