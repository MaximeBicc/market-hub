import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Build de la PWA.
 *
 * `injectManifest` (et non `generateSW`) : on écrit nous-mêmes le service
 * worker parce qu'il doit gérer les notifications push, ce que la génération
 * automatique ne fait pas.
 *
 * En développement, /api est renvoyé vers `wrangler dev` : le front tourne sur
 * le serveur Vite avec rechargement à chaud, le back sur le vrai runtime
 * Workers avec les vraies liaisons D1 et Queue.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt", // on prévient l'utilisateur, on ne recharge pas de force
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
      },
      manifest: {
        name: "MarketHub — gestion multi-boutiques",
        short_name: "MarketHub",
        description:
          "Commandes, stock et prix de toutes vos boutiques en ligne, au même endroit.",
        lang: "fr",
        start_url: "/",
        scope: "/",
        // "standalone" : sans barre d'adresse. Sur iOS, c'est cette valeur qui
        // fait que l'app ajoutée à l'écran d'accueil ressemble à une vraie app.
        display: "standalone",
        orientation: "portrait",
        // `background_color` peint l'écran de démarrage. On garde le fond
        // sombre de l'application plutôt que le blanc du logo : l'icône y
        // apparaît comme une tuile claire centrée, ce qui est habituel — alors
        // qu'un fond blanc provoquerait un éclair lumineux avant chaque
        // ouverture d'une interface sombre.
        background_color: "#0b0d12",
        // `theme_color` teinte la barre d'état Android et la vignette du
        // sélecteur d'applications : c'est le bleu nuit du logo.
        theme_color: "#081A46",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable", // évite l'icône rognée sur Android
          },
        ],
        shortcuts: [
          { name: "Commandes", url: "/orders" },
          { name: "Stock", url: "/inventory" },
        ],
      },
      devOptions: { enabled: true, type: "module" },
    }),
  ],
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787", // wrangler dev
        changeOrigin: false,
      },
    },
  },
});
