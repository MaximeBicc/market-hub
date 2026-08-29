import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  money,
  type InventoryResponse,
  type ProductItem,
  type ConsumableItem,
  type ListingRow,
} from "../lib/api.js";
import { Empty } from "../components/Empty.js";
import { Icon } from "../components/Icon.js";
import { toast } from "../components/Toast.js";
import { ProductModal } from "../components/ProductModal.js";
import { AlibabaModal } from "../components/AlibabaModal.js";
import { ConsumableModal } from "../components/ConsumableModal.js";
import { FulfillmentModal } from "../components/FulfillmentModal.js";
import { PalmLoader } from "../components/PalmLoader.js";

const CATEGORY_ICONS: Record<string, string> = {
  envelope: "✉️",
  box: "📦",
  label: "🏷️",
  card: "💳",
  protection: "🛡️",
  other: "📌",
};

function getTagsArray(tags: unknown): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.filter((t): t is string => typeof t === "string" && Boolean(t.trim()));
  if (typeof tags === "string") {
    try {
      const parsed = JSON.parse(tags);
      if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === "string" && Boolean(t.trim()));
    } catch {}
    return tags.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

/**
 * OÙ CE PRODUIT EST-IL EN VENTE, ET COMMENT Y ALLER.
 *
 * Une pastille par boutique qui porte une annonce. Cliquable quand on connaît
 * son adresse, inerte sinon — un lien qui tombe sur une page d'erreur coûte
 * plus cher que pas de lien.
 *
 * Le statut se lit sans ouvrir : une annonce hors ligne est grisée. C'est la
 * distinction qui manquait le plus — « publié » et « en vente » ne sont pas
 * la même chose, et rien dans l'inventaire ne les séparait.
 */
const BOUTIQUES: Record<string, { nom: string; lettre: string }> = {
  ebay: { nom: "eBay", lettre: "e" },
  etsy: { nom: "Etsy", lettre: "E" },
  shopify: { nom: "Shopify", lettre: "S" },
  alibaba: { nom: "Alibaba", lettre: "A" },
};

function Annonces({
  listings,
  produitId,
  aDesPhotosDeColoris,
}: {
  listings?: ListingRow[] | undefined;
  produitId: string;
  /** Vrai quand au moins une déclinaison porte une photo propre. */
  aDesPhotosDeColoris: boolean;
}) {
  const rows = listings ?? [];

  /*
   * ILLUSTRER LES COLORIS D'UNE ANNONCE DÉJÀ EN LIGNE.
   *
   * Le rattachement « choisir Noir change l'image » se fait à la création.
   * Une annonce publiée avant que la fonction existe ne l'a pas, et
   * republier coûterait un frais d'insertion chez Etsy. Ce bouton ne touche
   * QUE les visuels — ni le prix, ni le stock, ni le texte.
   *
   * Il n'apparaît que s'il a quelque chose à faire : au moins une annonce et
   * au moins une photo de coloris.
   */
  const illustrer = useMutation({
    mutationFn: () =>
      api.post<{ results: Array<{ marketplace: string; status: string; message?: string }> }>(
        "/engine/photos",
        { productId: produitId },
      ),
    onSuccess: (r) => {
      const ok = r.results.filter((x) => x.status === "success");
      const rates = r.results.filter((x) => x.status !== "success");
      toast(
        rates.length === 0
          ? `Coloris illustrés sur ${ok.map((x) => x.marketplace).join(", ")}`
          : `${ok.length > 0 ? `Fait sur ${ok.map((x) => x.marketplace).join(", ")}. ` : ""}${rates[0]?.marketplace} : ${rates[0]?.message ?? "échec"}`,
      );
    },
    onError: (e: unknown) =>
      toast(e instanceof Error ? e.message : "Échec"),
  });

  if (rows.length === 0) return null;

  return (
    <span className="annonces">
      {rows.map((l) => {
        const b = BOUTIQUES[l.platform];
        const enLigne = l.status === "active";
        const contenu = (
          <>
            <span aria-hidden="true">{b?.lettre ?? l.platform[0]?.toUpperCase()}</span>
            {b?.nom ?? l.platform}
          </>
        );
        const titre = `${b?.nom ?? l.platform} — ${
          enLigne ? "en vente" : "hors ligne"
        }${l.url ? "" : " (adresse inconnue)"}`;

        return l.url ? (
          <a
            key={l.id}
            className={`annonce-pastille annonce-pastille--${l.platform}${enLigne ? "" : " annonce-pastille--off"}`}
            href={l.url}
            target="_blank"
            rel="noreferrer"
            title={titre}
            /* Le clic ne doit pas ouvrir la fiche produit en dessous. */
            onClick={(e) => e.stopPropagation()}
          >
            {contenu}
          </a>
        ) : (
          <span
            key={l.id}
            className={`annonce-pastille annonce-pastille--${l.platform} annonce-pastille--muet${enLigne ? "" : " annonce-pastille--off"}`}
            title={titre}
          >
            {contenu}
          </span>
        );
      })}
      {aDesPhotosDeColoris && (
        <button
          type="button"
          className="annonce-illustrer"
          title="Rattacher chaque photo à son coloris sur les boutiques — ne touche ni au prix, ni au stock, ni au texte"
          disabled={illustrer.isPending}
          onClick={(e) => {
            e.stopPropagation();
            illustrer.mutate();
          }}
        >
          {illustrer.isPending ? "…" : "Illustrer les coloris"}
        </button>
      )}
    </span>
  );
}

export function Inventory() {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<"products" | "consumables" | "channels">("products");
  const [search, setSearch] = useState("");
  /** Produit dont les déclinaisons sont dépliées, le cas échéant. */
  const [deplie, setDeplie] = useState<string | null>(null);
  /** Le formulaire d'import Alibaba, ouvert ou non. */
  const [importAlibaba, setImportAlibaba] = useState(false);
  const [onlyLowStock, setOnlyLowStock] = useState(false);

  const [selectedProduct, setSelectedProduct] = useState<ProductItem | null | "new">(null);
  const [selectedConsumable, setSelectedConsumable] = useState<ConsumableItem | null | "new">(null);
  const [fulfillingOrderId, setFulfillingOrderId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<InventoryResponse>({
    queryKey: ["inventory"],
    queryFn: () => api.get<InventoryResponse>("/inventory"),
  });

  // Simuler une commande de test pour un produit
  const simulateOrderMutation = useMutation({
    mutationFn: (productId?: string) =>
      api.post<{ ok: boolean; orderId: string }>("/orders/sample", productId ? { productId } : {}),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      if (res.orderId) {
        setFulfillingOrderId(res.orderId);
      }
    },
  });

  // Ajustement rapide du stock produit
  const setProductStockMutation = useMutation({
    mutationFn: (v: { id: string; stock: number }) =>
      api.post(`/products/${v.id}/stock`, { stock: v.stock }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      toast("Stock produit mis à jour");
    },
  });

  // Ajustement rapide du stock consommable
  const setConsumableStockMutation = useMutation({
    mutationFn: (v: { id: string; stock: number }) =>
      api.post(`/consumables/${v.id}/stock`, { stock: v.stock }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      toast("Stock consommable mis à jour");
    },
  });

  // Ajustement vers une marketplace
  const setListingStockMutation = useMutation({
    mutationFn: (v: { shopId: string; externalId: string; quantity: number }) =>
      api.post(`/listings/${v.shopId}/${encodeURIComponent(v.externalId)}/stock`, {
        quantity: v.quantity,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      toast("Mise à jour demandée à la plateforme");
    },
  });

  if (isLoading || !data) return <PalmLoader label="Chargement du stock…" />;

  const products = data.products ?? [];
  const consumables = data.consumables ?? [];
  const listings = data.listings ?? [];
  const multiChannel = data.multiChannel ?? [];
  const stats = data.stats ?? {
    totalProducts: products.length,
    totalStockUnits: products.reduce((s, p) => s + p.stock, 0),
    totalStockValue: products.reduce((s, p) => s + p.stock * p.priceAmount, 0),
    lowStockProductsCount: products.filter((p) => p.stock <= p.minAlert).length,
    lowStockConsumablesCount: consumables.filter((c) => c.stock <= c.minAlert).length,
  };

  // Filtrage des produits
  const filteredProducts = products.filter((p) => {
    if (onlyLowStock && p.stock > p.minAlert) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const matchSku = p.sku.toLowerCase().includes(q);
      const matchTitle = p.title.toLowerCase().includes(q);
      const matchLoc = p.location?.toLowerCase().includes(q);
      const matchColor = p.color?.toLowerCase().includes(q);
      const matchMat = p.material?.toLowerCase().includes(q);
      const pTags = getTagsArray(p.tags);
      const matchTag = pTags.some((t) => t.toLowerCase().includes(q));
      if (!matchSku && !matchTitle && !matchLoc && !matchColor && !matchMat && !matchTag) return false;
    }
    return true;
  });

  // Filtrage des consommables
  const filteredConsumables = consumables.filter((c) => {
    if (onlyLowStock && c.stock > c.minAlert) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const matchName = c.name.toLowerCase().includes(q);
      const matchCat = c.category.toLowerCase().includes(q);
      if (!matchName && !matchCat) return false;
    }
    return true;
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Gestion des Stocks & Fournitures</h1>
          <p>
            {stats.totalProducts} produit{stats.totalProducts > 1 ? "s" : ""} maître ·{" "}
            {stats.totalStockUnits} unités en réserve · Valeur : {money(stats.totalStockValue)}
          </p>
        </div>

        <div className="page-head__actions">
          {activeTab === "products" && (
            <>
              {/* L'import passe avant la saisie : c'est le geste courant dès
                  qu'un fournisseur est branché. La saisie manuelle reste
                  pour ce qui ne vient d'aucune place de marché. */}
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setImportAlibaba(true)}
                title="Coller un lien Alibaba et reprendre toute la fiche"
              >
                <Icon name="upload" /> Depuis Alibaba
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setSelectedProduct("new")}
              >
                <Icon name="plus" /> Nouveau produit
              </button>
            </>
          )}

          {activeTab === "consumables" && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setSelectedConsumable("new")}
            >
              <Icon name="plus" /> Nouveau consommable
            </button>
          )}
        </div>
      </div>

      {/* Cartes KPI */}
      <div className="stock-kpi-grid">
        <div className="stock-kpi-card">
          <span className="stock-kpi-title">Articles en stock</span>
          <span className="stock-kpi-val">{stats.totalStockUnits}</span>
          <span className="stock-kpi-sub">{stats.totalProducts} références catalogue</span>
        </div>

        <div className="stock-kpi-card">
          <span className="stock-kpi-title">Valeur marchande</span>
          <span className="stock-kpi-val">{money(stats.totalStockValue)}</span>
          <span className="stock-kpi-sub">Prix de vente catalogue</span>
        </div>

        <div
          className={`stock-kpi-card ${
            stats.lowStockProductsCount > 0 ? "stock-kpi-card--warn" : ""
          }`}
        >
          <span className="stock-kpi-title">Alertes produits</span>
          <span className="stock-kpi-val">{stats.lowStockProductsCount}</span>
          <span className="stock-kpi-sub">
            {stats.lowStockProductsCount === 0 ? "Tous les stocks sont OK" : "Sous le seuil d'alerte"}
          </span>
        </div>

        <div
          className={`stock-kpi-card ${
            stats.lowStockConsumablesCount > 0 ? "stock-kpi-card--warn" : ""
          }`}
        >
          <span className="stock-kpi-title">Emballages & Fournitures</span>
          <span className="stock-kpi-val">
            {consumables.reduce((s, c) => s + c.stock, 0)}
          </span>
          <span className="stock-kpi-sub">
            {stats.lowStockConsumablesCount > 0
              ? `${stats.lowStockConsumablesCount} fourniture(s) à réapprovisionner`
              : `${consumables.length} types d'emballages`}
          </span>
        </div>
      </div>

      {/* Onglets principaux */}
      <div className="orders-toolbar" style={{ marginTop: 16 }}>
        <div className="filters">
          <button
            className="chip"
            aria-pressed={activeTab === "products"}
            onClick={() => setActiveTab("products")}
          >
            📦 Produits du catalogue ({products.length})
          </button>
          <button
            className="chip"
            aria-pressed={activeTab === "consumables"}
            onClick={() => setActiveTab("consumables")}
          >
            ✉️ Consommables d'emballage ({consumables.length})
          </button>
          <button
            className="chip"
            aria-pressed={activeTab === "channels"}
            onClick={() => setActiveTab("channels")}
          >
            🌐 Multi-canaux & Annonces ({listings.length})
          </button>
        </div>

        {/* Barre de recherche et filtre stock bas */}
        {(activeTab === "products" || activeTab === "consumables") && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div className="orders-search" style={{ flex: 1 }}>
              <input
                type="text"
                className="input input--search"
                placeholder={
                  activeTab === "products"
                    ? "Rechercher par SKU, titre, emplacement..."
                    : "Rechercher un consommable..."
                }
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  onClick={() => setSearch("")}
                >
                  Effacer
                </button>
              )}
            </div>

            <button
              type="button"
              className="chip"
              aria-pressed={onlyLowStock}
              onClick={() => setOnlyLowStock(!onlyLowStock)}
            >
              ⚠️ Uniquement stocks bas
            </button>
          </div>
        )}
      </div>

      {/* ================================================================ */}
      {/* ONGLET 1 : PRODUITS DU CATALOGUE                                 */}
      {/* ================================================================ */}
      {activeTab === "products" && (
        <>
          {filteredProducts.length === 0 ? (
            products.length === 0 ? (
              <Empty
                icon="box"
                title="Aucun produit dans le catalogue"
                action={
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => setSelectedProduct("new")}
                  >
                    <Icon name="plus" /> Ajouter mon premier produit
                  </button>
                }
              >
                Créez vos fiches produits avec leur SKU, leur stock initial, leur emplacement en
                atelier et leur format d'emballage. Les commandes reçues décrémenteront
                automatiquement ces quantités !
              </Empty>
            ) : (
              <div className="empty" style={{ margin: "20px 0" }}>
                <span className="empty__t">Aucun produit ne correspond à la recherche</span>
                <span className="empty__d">Essayez de réinitialiser la recherche ou les filtres.</span>
              </div>
            )
          ) : (
            <div className="product-inventory-list">
              {filteredProducts.map((p) => {
                const isLow = p.stock > 0 && p.stock <= p.minAlert;
                const isOut = p.stock === 0;
                const margin = p.costPrice ? p.priceAmount - p.costPrice : null;
                const defaultConsumable = consumables.find((c) => c.id === p.defaultConsumableId);

                return (
                  <div key={p.id}>
                  <div
                    className={`product-inventory-card ${
                      isOut ? "row--out" : isLow ? "row--low" : ""
                    }`}
                  >
                    {/* Colonne 1 : Visuel ou SKU Badge */}
                    {p.images?.[0] ? (
                      <img className="thumb" src={p.images[0]} alt="" loading="lazy" />
                    ) : (
                      <span className="mono-badge">{p.sku.slice(0, 2).toUpperCase()}</span>
                    )}

                    {/* Colonne 2 : Infos principales */}
                    <div className="product-card-main">
                      <div className="product-card-title-row">
                        {/* La flèche n'apparaît que s'il y a des déclinaisons.
                            Un chevron devant un produit qui n'en a pas serait
                            une promesse vide. */}
                        {(p.variantCount ?? 0) > 1 && (
                          <button
                            type="button"
                            className="chevron-variantes"
                            aria-expanded={deplie === p.id}
                            title={
                              deplie === p.id
                                ? "Masquer les déclinaisons"
                                : `Voir les ${p.variantCount} déclinaisons`
                            }
                            onClick={() => setDeplie(deplie === p.id ? null : p.id)}
                          >
                            <Icon name={deplie === p.id ? "chevronLeft" : "chevronRight"} />
                          </button>
                        )}
                        <span className="product-card-title">{p.title}</span>
                        <code className="product-card-sku">{p.sku}</code>
                        <Annonces
                          listings={p.listings}
                          produitId={p.id}
                          aDesPhotosDeColoris={(p.variantCount ?? 0) > 1}
                        />
                        {isOut && <span className="pill pill--stop">Rupture</span>}
                        {isLow && <span className="pill pill--warn">Stock bas (≤ {p.minAlert})</span>}
                      </div>

                      <div className="product-card-meta-row">
                        {p.location && (
                          <span className="meta-tag">
                            📍 <b>{p.location}</b>
                          </span>
                        )}
                        {p.color && (
                          <span className="meta-tag">
                            🎨 <b>{p.color}</b>
                          </span>
                        )}
                        {p.material && (
                          <span className="meta-tag">
                            🧶 <b>{p.material}</b>
                          </span>
                        )}
                        {p.weightGrams && (
                          <span className="meta-tag">⚖️ {p.weightGrams}g</span>
                        )}
                        {defaultConsumable && (
                          <span className="meta-tag">✉️ {defaultConsumable.name}</span>
                        )}
                        {(() => {
                          const pTags = getTagsArray(p.tags);
                          if (pTags.length === 0) return null;
                          return (
                            <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                              {pTags.slice(0, 3).map((t) => (
                                <span key={t} className="meta-tag" style={{ fontSize: 10.5, opacity: 0.85 }}>
                                  #{t}
                                </span>
                              ))}
                            </span>
                          );
                        })()}
                        {(p.variantCount ?? 0) > 1 && (
                          <span className="meta-tag">
                            🎚️ <b>{p.variantCount}</b> déclinaisons
                          </span>
                        )}
                        <span className="meta-tag">
                          💰 Vente : <b>{money(p.priceAmount, p.priceCurrency)}</b>
                          {p.costPrice && (
                            <span className="muted" style={{ marginLeft: 4 }}>
                              (Coût : {money(p.costPrice)} · Marge :{" "}
                              <span style={{ color: "var(--ok)", fontWeight: 600 }}>
                                +{money(margin ?? 0)}
                              </span>
                              )
                            </span>
                          )}
                        </span>
                      </div>
                    </div>

                    {/* Colonne 3 : Ajusteur de stock rapide */}
                    <div className="product-card-stock-control">
                      <div className="stock-counter-wrapper">
                        <button
                          type="button"
                          className="qty-btn"
                          onClick={() =>
                            setProductStockMutation.mutate({
                              id: p.id,
                              stock: Math.max(0, p.stock - 1),
                            })
                          }
                          title="-1 unité"
                        >
                          <Icon name="minus" />
                        </button>
                        <input
                          type="number"
                          className="input font-mono qty-input-box"
                          min={0}
                          defaultValue={p.stock}
                          key={p.stock}
                          onBlur={(e) => {
                            const val = Number(e.target.value);
                            if (val !== p.stock && Number.isInteger(val) && val >= 0) {
                              setProductStockMutation.mutate({ id: p.id, stock: val });
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="qty-btn"
                          onClick={() =>
                            setProductStockMutation.mutate({
                              id: p.id,
                              stock: p.stock + 1,
                            })
                          }
                          title="+1 unité"
                        >
                          <Icon name="plus" />
                        </button>
                      </div>

                      <button
                        type="button"
                        className="btn btn--small btn--ghost"
                        onClick={() => setSelectedProduct(p)}
                        title="Modifier tous les détails du produit"
                      >
                        Modifier
                      </button>

                      <button
                        type="button"
                        className="btn btn--small btn--primary"
                        onClick={() => simulateOrderMutation.mutate(p.id)}
                        disabled={simulateOrderMutation.isPending}
                        title="Créer une commande test pour ce produit et ouvrir le flux d'exécution"
                      >
                        <Icon name="box" /> Tester commande
                      </button>
                    </div>
                  </div>

                  {deplie === p.id && <DeclinaisonsProduit produitId={p.id} />}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ================================================================ */}
      {/* ONGLET 2 : FOURNITURES & CONSOMMABLES D'EMBALLAGE               */}
      {/* ================================================================ */}
      {activeTab === "consumables" && (
        <>
          {filteredConsumables.length === 0 ? (
            <div className="empty" style={{ margin: "20px 0" }}>
              <span className="empty__t">Aucun consommable d'emballage</span>
              <span className="empty__d">
                Cliquez sur « Nouveau consommable » pour ajouter des enveloppes, cartons, cartes ou
                étiquettes.
              </span>
            </div>
          ) : (
            <div className="consumables-grid" style={{ marginTop: 10 }}>
              {filteredConsumables.map((c) => {
                const isLow = c.stock > 0 && c.stock <= c.minAlert;
                const isOut = c.stock === 0;

                return (
                  <div
                    key={c.id}
                    className={`consumable-card ${
                      isOut ? "consumable-card--out" : isLow ? "consumable-card--low" : ""
                    }`}
                  >
                    <div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <span className="consumable-category">
                          {CATEGORY_ICONS[c.category] ?? "📦"} {c.category}
                        </span>
                        {isOut ? (
                          <span className="stock-pill stock-pill--out">Rupture</span>
                        ) : isLow ? (
                          <span className="stock-pill stock-pill--low">Alerte réappro</span>
                        ) : (
                          <span className="stock-pill stock-pill--ok">En réserve</span>
                        )}
                      </div>
                      <h3 className="consumable-name">{c.name}</h3>

                      <div className="consumable-stock-line">
                        <span className="cost-pill">
                          Coût unitaire : <b>{c.unitCost ? money(c.unitCost) : "—"}</b>
                        </span>
                        <span className="cost-pill">· Seuil alerte : ≤ {c.minAlert}</span>
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginTop: 10,
                        borderTop: "1px solid var(--rule-soft)",
                        paddingTop: 8,
                      }}
                    >
                      <button
                        type="button"
                        className="btn btn--small btn--ghost"
                        onClick={() => setSelectedConsumable(c)}
                      >
                        Détails
                      </button>

                      <div className="qty-control">
                        <button
                          type="button"
                          className="qty-btn"
                          onClick={() =>
                            setConsumableStockMutation.mutate({
                              id: c.id,
                              stock: Math.max(0, c.stock - 5),
                            })
                          }
                          title="-5"
                        >
                          -5
                        </button>
                        <button
                          type="button"
                          className="qty-btn"
                          onClick={() =>
                            setConsumableStockMutation.mutate({
                              id: c.id,
                              stock: Math.max(0, c.stock - 1),
                            })
                          }
                          title="-1"
                        >
                          <Icon name="minus" />
                        </button>
                        <span className="qty-val font-mono">{c.stock}</span>
                        <button
                          type="button"
                          className="qty-btn"
                          onClick={() =>
                            setConsumableStockMutation.mutate({
                              id: c.id,
                              stock: c.stock + 1,
                            })
                          }
                          title="+1"
                        >
                          <Icon name="plus" />
                        </button>
                        <button
                          type="button"
                          className="qty-btn"
                          onClick={() =>
                            setConsumableStockMutation.mutate({
                              id: c.id,
                              stock: c.stock + 5,
                            })
                          }
                          title="+5"
                        >
                          +5
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ================================================================ */}
      {/* ONGLET 3 : MULTI-CANAUX & ANNONCES                               */}
      {/* ================================================================ */}
      {activeTab === "channels" && (
        <>
          {multiChannel.length > 0 && (
            <>
              <h2 className="sec">
                Présent sur plusieurs canaux
                <span>{multiChannel.length} références</span>
              </h2>
              {multiChannel.map((g) => {
                const prices = g.listings.map((l) => l.price);
                const spread = Math.max(...prices) - Math.min(...prices);
                return (
                  <div className="card" key={g.sku} style={{ marginBottom: 9 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 10,
                      }}
                    >
                      <code className="amount">{g.sku}</code>
                      {spread > 0 ? (
                        <span className="pill pill--warn">écart {money(spread)}</span>
                      ) : (
                        <span className="pill pill--ok">aligné</span>
                      )}
                    </div>
                    <div className="rows">
                      {g.listings.map((l) => (
                        <div className="row" key={l.id} style={{ background: "var(--card-2)" }}>
                          <span className="row__main">{l.platform}</span>
                          <span className="amount">{money(l.price, l.currency)}</span>
                          <span className="muted">{l.quantity} en stock</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          )}

          <h2 className="sec">
            Toutes les annonces synchronisées <span>{listings.length}</span>
          </h2>
          {listings.length === 0 ? (
            <Empty icon="box" title="Aucune annonce connectée">
              Les annonces apparaîtront automatiquement dès la synchronisation d'une boutique.
            </Empty>
          ) : (
            <div className="rows">
              {listings.map((l) => (
                <div
                  className={
                    l.quantity === 0 ? "row row--out" : l.quantity <= 3 ? "row row--low" : "row"
                  }
                  key={l.id}
                >
                  {l.imageUrl ? (
                    <img className="thumb" src={l.imageUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="mono-badge">{(l.sku ?? "—").slice(0, 2)}</span>
                  )}
                  <div className="row__main">
                    <div className="row__t">{l.title}</div>
                    <div className="row__s">
                      {l.shopName} · {l.sku ?? "sans SKU"}
                    </div>
                  </div>
                  <div className="row__end">
                    <span className="amount">{money(l.price, l.currency)}</span>
                    <input
                      className="qty"
                      type="number"
                      min={0}
                      defaultValue={l.quantity}
                      aria-label={`Quantité — ${l.title}`}
                      onBlur={(e) => {
                        const q = Number(e.target.value);
                        if (q !== l.quantity && Number.isInteger(q) && q >= 0) {
                          setListingStockMutation.mutate({
                            shopId: l.shopId,
                            externalId: l.externalId,
                            quantity: q,
                          });
                        }
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Modal Produit */}
      {importAlibaba && (
        <AlibabaModal onClose={() => setImportAlibaba(false)} />
      )}
      {selectedProduct && (
        <ProductModal
          product={selectedProduct === "new" ? null : selectedProduct}
          consumables={consumables}
          onClose={() => setSelectedProduct(null)}
        />
      )}

      {/* Modal Consommable */}
      {selectedConsumable && (
        <ConsumableModal
          consumable={selectedConsumable === "new" ? null : selectedConsumable}
          onClose={() => setSelectedConsumable(null)}
        />
      )}

      {/* Modal d'exécution de commande (5 étapes) */}
      {fulfillingOrderId && (
        <FulfillmentModal
          orderId={fulfillingOrderId}
          onClose={() => setFulfillingOrderId(null)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ["inventory"] });
            qc.invalidateQueries({ queryKey: ["orders"] });
          }}
        />
      )}
    </>
  );
}


interface DeclinaisonLigne {
  id: string;
  sku: string | null;
  optionValues: string[];
  priceAmount: number;
  priceCurrency: string;
  /** La photo du coloris. L'API la renvoyait déjà ; l'écran l'ignorait. */
  imageUrl: string | null;
  status: string;
  onHand: number | null;
  reserved: number | null;
}

/**
 * Les déclinaisons d'un produit, dépliées sous sa ligne.
 *
 * La liste du stock affichait un seul nombre par produit — la somme. Pour un
 * support téléphone en dix-sept coloris, ce nombre ne dit pas lequel est
 * épuisé : on voit « 95 en stock » et on découvre à la vente que le violet
 * était à zéro depuis trois semaines.
 *
 * Chargées à l'ouverture seulement : les précharger pour tous les produits de
 * la liste coûterait une requête par ligne sur un écran qui les montre tous.
 */
function DeclinaisonsProduit({ produitId }: { produitId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["variantes", produitId],
    queryFn: () =>
      api.get<{ variantes: DeclinaisonLigne[] }>(
        `/products/${produitId}/variantes`,
      ),
  });

  if (isLoading) {
    return (
      <div className="declinaisons">
        <PalmLoader compact label="Lecture des déclinaisons…" />
      </div>
    );
  }

  const lignes = (data?.variantes ?? []).filter((v) => v.status === "active");
  if (lignes.length === 0) return null;

  return (
    <div className="declinaisons">
      {lignes.map((v) => (
        <div className="declinaisons__ligne" key={v.id}>
          {/*
            LA PHOTO AVANT LE NOM.
            « Bleu marine » et « Bleu nuit » ne se distinguent pas de mémoire :
            sur un produit à dix-sept coloris, c'est la vignette qui dit lequel
            est épuisé, pas son intitulé. Un carré neutre tient la place quand
            la déclinaison n'a pas d'image, pour que la colonne des noms reste
            alignée d'une ligne à l'autre.
          */}
          {v.imageUrl ? (
            <img
              className="declinaisons__photo"
              src={v.imageUrl}
              alt=""
              loading="lazy"
              /* Une URL morte laisserait une icône cassée : on retombe sur la
                 place vide, qui ne prétend rien. */
              onError={(e) => {
                e.currentTarget.style.visibility = "hidden";
              }}
            />
          ) : (
            <span className="declinaisons__photo declinaisons__photo--vide" aria-hidden="true" />
          )}
          <span className="declinaisons__nom">
            {v.optionValues.join(" · ") || "sans déclinaison"}
          </span>
          <span className="muted">{v.sku ?? "sans SKU"}</span>
          <span className="muted">{money(v.priceAmount, v.priceCurrency)}</span>
          <span
            className={
              v.onHand === null || v.onHand === 0 ? "pill pill--stop" : "amount"
            }
          >
            {v.onHand === null
              ? "inconnu"
              : v.onHand === 0
                ? "épuisé"
                : `${v.onHand}`}
          </span>
        </div>
      ))}
    </div>
  );
}
