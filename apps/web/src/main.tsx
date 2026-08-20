import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App.js";
import "./index.css";

/**
 * Amorçage de la PWA.
 *
 * Le cache de requêtes est réglé pour un usage mobile : on considère une donnée
 * fraîche pendant 30 secondes, et on la revalide au retour sur l'application.
 * Résultat : rouvrir l'app depuis l'écran d'accueil affiche immédiatement les
 * dernières données connues, puis les rafraîchit en arrière-plan.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 24 * 3600_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

// `registerType: "prompt"` côté Vite : on ne recharge jamais la page sous les
// doigts de l'utilisateur. On lui propose, il décide.
const updateSW = registerSW({
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent("sw:update-available"));
  },
});
window.addEventListener("sw:apply-update", () => void updateSW(true));

// Le service worker demande une navigation après un clic sur notification.
navigator.serviceWorker?.addEventListener("message", (event) => {
  const data = event.data as { type?: string; url?: string };
  if (data?.type === "navigate" && data.url) {
    window.history.pushState({}, "", data.url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
