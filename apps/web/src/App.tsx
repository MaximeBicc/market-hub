import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api.js";
import { Login } from "./pages/Login.js";
import { Overview } from "./pages/Overview.js";
import { Orders } from "./pages/Orders.js";
import { Inventory } from "./pages/Inventory.js";
import { Growth } from "./pages/Growth.js";
import { Analyse } from "./pages/Analyse.js";
import { Publier } from "./pages/Publier.js";
import { Shops } from "./pages/Shops.js";
import { Settings } from "./pages/Settings.js";
import { Icon } from "./components/Icon.js";
import { Toast } from "./components/Toast.js";

/**
 * Coque de l'application.
 *
 * Une seule définition de navigation alimente les deux dispositions :
 * barre latérale persistante sur écran large, onglets en bas sur téléphone.
 * Dupliquer la liste ferait dériver les deux au premier ajout de page.
 */
// `end` est explicite sur chaque entree : sous `exactOptionalPropertyTypes`,
// une propriete absente sur certains elements donne le type `boolean |
// undefined`, que NavLink refuse. Seule la racine doit correspondre de facon
// exacte — sans quoi elle resterait active sur toutes les autres pages.
const NAV = [
  { to: "/", label: "Accueil", icon: "home" as const, end: true },
  { to: "/orders", label: "Commandes", icon: "orders" as const, end: false },
  { to: "/inventory", label: "Stock", icon: "box" as const, end: false },
  { to: "/growth", label: "Croissance", icon: "chart" as const, end: false },
  { to: "/analyse", label: "Analyse", icon: "sparkle" as const, end: false },
  { to: "/publier", label: "Publier", icon: "upload" as const, end: false },
  { to: "/shops", label: "Boutiques", icon: "shops" as const, end: false },
];

const TITLES: Record<string, string> = {
  "/": "Accueil",
  "/orders": "Commandes",
  "/inventory": "Stock",
  "/growth": "Croissance",
  "/analyse": "Analyse",
  "/publier": "Publier",
  "/shops": "Boutiques",
  "/settings": "Réglages",
};

interface AuthState {
  authenticated: boolean;
  username: string | null;
  displayName: string | null;
}

/**
 * Analyses en cours, vues depuis n'importe quel écran.
 *
 * Interrogé au serveur et non lu dans le stockage du navigateur : une analyse
 * lancée depuis le téléphone doit se signaler sur l'ordinateur. C'est tout
 * l'intérêt de la faire tourner sur Cloudflare plutôt que dans l'onglet.
 *
 * React Query suspend l'intervalle quand la fenêtre n'a pas le focus : une
 * application posée sur le bureau n'interroge rien.
 */
function useTravauxEnCours(actif: boolean): number {
  const { data } = useQuery({
    queryKey: ["ai-jobs-running"],
    queryFn: () => api.get<{ jobs: unknown[] }>("/ai/jobs"),
    refetchInterval: 20_000,
    enabled: actif,
    retry: false,
  });
  return data?.jobs.length ?? 0;
}

export function App() {
  const { data: auth, isLoading } = useQuery({
    queryKey: ["auth"],
    queryFn: () => api.get<AuthState>("/auth/state"),
    staleTime: 0,
    retry: false,
  });

  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    const h = () => setUpdateReady(true);
    window.addEventListener("sw:update-available", h);
    return () => window.removeEventListener("sw:update-available", h);
  }, []);

  const location = useLocation();
  const travaux = useTravauxEnCours(Boolean(auth?.authenticated));

  if (isLoading) return <div className="boot">…</div>;
  if (!auth?.authenticated) return <Login />;

  const title = TITLES[location.pathname] ?? "MarketHub";

  return (
    <>
      {updateReady && (
        <button
          className="update-banner"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("sw:apply-update"))
          }
        >
          Nouvelle version disponible — appuyer pour mettre à jour
        </button>
      )}

      <div className="shell">
        {/* --- Barre latérale : écrans larges --- */}
        <aside className="sidebar">
          <div className="side-brand">
            <img src="/icons/icon-192.png" alt="" />
            <b>MarketHub</b>
          </div>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="side-link">
              <Icon name={n.icon} />
              {n.label}
              {n.to === "/analyse" && travaux > 0 && <Pastille n={travaux} />}
            </NavLink>
          ))}
          <NavLink to="/settings" className="side-link">
            <Icon name="settings" />
            Réglages
          </NavLink>
          <div className="side-foot">
            <span>{auth.displayName}</span>
            <span>{auth.username}</span>
          </div>
        </aside>

        {/* --- Barre supérieure : téléphone --- */}
        <header className="topbar">
          <img className="topbar__logo" src="/icons/icon-192.png" alt="" />
          <h1 className="topbar__title">{title}</h1>
          <NavLink to="/settings" className="topbar__who">
            {auth.displayName}
          </NavLink>
        </header>

        <main className="main">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/growth" element={<Growth />} />
            <Route path="/analyse" element={<Analyse />} />
            <Route path="/publier" element={<Publier />} />
            <Route path="/shops" element={<Shops />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>

        {/* --- Onglets : téléphone --- */}
        <nav className="tabbar" aria-label="Navigation principale">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="tab">
              <span className="tab__icon">
                <Icon name={n.icon} />
                {n.to === "/analyse" && travaux > 0 && <Pastille n={travaux} />}
              </span>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <Toast />
    </>
  );
}

/** Compteur discret : une analyse tourne, il y a quelque chose à venir chercher. */
function Pastille({ n }: { n: number }) {
  return (
    <span className="pastille" aria-label={`${n} analyse${n > 1 ? "s" : ""} en cours`}>
      {n}
    </span>
  );
}
