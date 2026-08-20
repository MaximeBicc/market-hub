/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { NetworkFirst, StaleWhileRevalidate } from "workbox-strategies";
import type { WorkboxPlugin } from "workbox-core";
import { registerRoute } from "workbox-routing";
import { ExpirationPlugin } from "workbox-expiration";

declare const self: ServiceWorkerGlobalScope;

/**
 * `ExpirationPlugin` déclare ses gestionnaires comme optionnels, ce que
 * l'interface `WorkboxPlugin` refuse sous `exactOptionalPropertyTypes`.
 * Incompatibilité entre deux paquets Workbox, pas une erreur de notre code :
 * on la contient ici plutôt que d'assouplir la règle pour tout le projet.
 */
const expire = (options: ConstructorParameters<typeof ExpirationPlugin>[0]) =>
  new ExpirationPlugin(options) as WorkboxPlugin;

/**
 * Service worker — c'est lui qui fait d'un site web une application.
 *
 * Trois rôles distincts :
 *   1. Rendre l'app installable et utilisable hors connexion (coque + dernières
 *      données lues).
 *   2. Recevoir les notifications push, y compris application fermée.
 *   3. Router le clic sur une notification vers le bon écran.
 */

/* ---------------------------- Cache ---------------------------- */

// La coque de l'application est précachée à l'installation : au lancement,
// l'interface s'affiche instantanément, sans attendre le réseau.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

/**
 * Données : réseau d'abord, cache en secours.
 * Un vendeur veut voir ses VRAIES commandes. On ne sert du cache que si le
 * réseau ne répond pas en 3 secondes — métro, ascenseur, réseau saturé.
 */
registerRoute(
  ({ url }) => url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth"),
  new NetworkFirst({
    cacheName: "api",
    networkTimeoutSeconds: 3,
    plugins: [expire({ maxEntries: 60, maxAgeSeconds: 86400 })],
  }),
);

// Vignettes produits : elles ne changent jamais, on sert le cache immédiatement
// et on rafraîchit en arrière-plan.
registerRoute(
  ({ request }) => request.destination === "image",
  new StaleWhileRevalidate({
    cacheName: "images",
    plugins: [expire({ maxEntries: 200, maxAgeSeconds: 30 * 86400 })],
  }),
);

/* ------------------------ Notifications ------------------------ */

self.addEventListener("push", (event: PushEvent) => {
  if (!event.data) return;

  let payload: { title: string; body: string; url?: string; tag?: string };
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "MarketHub", body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      // Même `tag` = la nouvelle notification remplace l'ancienne au lieu de
      // s'empiler. Trois ruptures de stock ne font pas trois alertes.
      tag: payload.tag ?? "default",
      data: { url: payload.url ?? "/" },
      // `renotify` (vibrer/sonner même en remplaçant une notification de même
      // tag) existe dans les navigateurs mais pas encore dans lib.dom.
      ...{ renotify: true },
    } as NotificationOptions),
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string })?.url ?? "/";

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Si l'app est déjà ouverte, on la met au premier plan et on navigue
      // dedans — ouvrir un second onglet serait désagréable.
      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          client.postMessage({ type: "navigate", url: target });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

/* ------------------------ Mise à jour ------------------------ */

// Permet à l'interface de déclencher l'activation d'une nouvelle version
// sans attendre la fermeture de tous les onglets.
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string })?.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});
