import { useEffect, useState } from "react";
import { Navigate, Route, Routes, NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Overview } from "./pages/Overview.js";
import { Orders } from "./pages/Orders.js";
import { Inventory } from "./pages/Inventory.js";
import { Settings } from "./pages/Settings.js";
import { Login } from "./pages/Login.js";
import { api } from "./lib/api.js";

/**
 * Coque de l'application.
 *
 * Navigation par onglets en bas d'écran : c'est un outil consulté au téléphone,
 * souvent d'une seule main. Les cibles tactiles font 48 px et respectent la
 * zone de sécurité iOS (env(safe-area-inset-bottom) dans index.css).
 */
export function App() {
  const { data: auth, isLoading } = useQuery({
    queryKey: ["auth"],
    queryFn: () => api.get<{ authenticated: boolean; initialized: boolean }>("/auth/state"),
    staleTime: 0,
  });

  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    const handler = () => setUpdateReady(true);
    window.addEventListener("sw:update-available", handler);
    return () => window.removeEventListener("sw:update-available", handler);
  }, []);

  if (isLoading) return <div className="boot">…</div>;
  if (!auth?.authenticated) return <Login initialized={auth?.initialized ?? false} />;

  return (
    <div className="app">
      {updateReady && (
        <button
          className="update-banner"
          onClick={() => window.dispatchEvent(new CustomEvent("sw:apply-update"))}
        >
          Nouvelle version disponible — appuyer pour mettre à jour
        </button>
      )}

      <main className="content">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/settings/*" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <nav className="tabbar">
        <Tab to="/" label="Accueil" />
        <Tab to="/orders" label="Commandes" />
        <Tab to="/inventory" label="Stock" />
        <Tab to="/settings" label="Réglages" />
      </nav>
    </div>
  );
}

function Tab({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) => (isActive ? "tab tab--active" : "tab")}
    >
      {label}
    </NavLink>
  );
}
