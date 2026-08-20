import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import {
  checkPushStatus,
  subscribeToPush,
  type PushStatus,
} from "../lib/push.js";

const PLATFORMS = [
  { id: "shopify", label: "Shopify", needsShop: true },
  { id: "etsy", label: "Etsy", needsShop: false },
  { id: "ebay", label: "eBay", needsShop: false },
  { id: "alibaba", label: "Alibaba", needsShop: false },
] as const;

/**
 * Réglages : connexion des boutiques, notifications, consommation LLM.
 *
 * L'encart notifications explique explicitement le cas iOS. Sans cette
 * explication, un utilisateur d'iPhone conclut que la fonctionnalité est
 * cassée, alors qu'il lui manque seulement l'ajout à l'écran d'accueil.
 */
export function Settings() {
  const [push, setPush] = useState<PushStatus | null>(null);
  const [shopDomain, setShopDomain] = useState("");

  useEffect(() => {
    void checkPushStatus().then(setPush);
  }, []);

  const { data: usage } = useQuery({
    queryKey: ["ai-usage"],
    queryFn: () =>
      api.get<{
        outputTokensUsed: number;
        limit: number;
        estimatedCostUsd: string;
      }>("/ai/usage"),
  });

  return (
    <div className="page">
      <h1>Réglages</h1>

      <h2>Connecter une boutique</h2>
      <ul className="list">
        {PLATFORMS.map((p) => (
          <li key={p.id} className="row">
            <span className="row__main">{p.label}</span>
            {p.needsShop && (
              <input
                className="input input--inline"
                placeholder="maboutique.myshopify.com"
                value={shopDomain}
                onChange={(e) => setShopDomain(e.target.value)}
              />
            )}
            <a
              className="btn"
              href={`/api/oauth/${p.id}/start${
                p.needsShop ? `?shop=${encodeURIComponent(shopDomain)}` : ""
              }`}
            >
              Connecter
            </a>
          </li>
        ))}
      </ul>

      <h2>Notifications</h2>
      {push?.state === "ready" && (
        <>
          <p className="ok">Notifications actives sur cet appareil.</p>
          <button className="btn" onClick={() => api.post("/push/test")}>
            Envoyer un test
          </button>
        </>
      )}
      {push?.state === "not-subscribed" && (
        <button
          className="btn btn--primary"
          onClick={() => void subscribeToPush().then(setPush)}
        >
          Activer les notifications
        </button>
      )}
      {push?.state === "needs-install" && (
        <p className="alert alert--warn">{push.reason}</p>
      )}
      {(push?.state === "denied" || push?.state === "unsupported") && (
        <p className="alert">{push.reason}</p>
      )}

      <h2>Assistant IA</h2>
      {usage && (
        <p className="muted">
          {usage.outputTokensUsed.toLocaleString("fr-FR")} jetons ce mois-ci sur{" "}
          {usage.limit.toLocaleString("fr-FR")} — environ {usage.estimatedCostUsd}{" "}
          $.
        </p>
      )}

      <h2>Compte</h2>
      <button
        className="btn btn--ghost"
        onClick={() =>
          api.post("/auth/logout").then(() => window.location.reload())
        }
      >
        Se déconnecter
      </button>
    </div>
  );
}
