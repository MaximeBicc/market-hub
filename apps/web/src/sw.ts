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
  ({ url }) =>
    url.pathname.startsWith("/api/") &&
    !url.pathname.startsWith("/api/auth") &&
    // Le relais d'images est une IMAGE, pas une donnée. Sans cette exclusion
    // il tomberait dans le cache « api », dont les soixante entrées seraient
    // vite mangées par des vignettes — au détriment des commandes et du stock.
    !url.pathname.startsWith("/api/alibaba/image"),
  new NetworkFirst({
    cacheName: "api",
    networkTimeoutSeconds: 3,
    plugins: [expire({ maxEntries: 60, maxAgeSeconds: 86400 })],
  }),
);

/*
 * VIGNETTES — ET SEULEMENT LES NÔTRES.
 *
 * Cette règle interceptait TOUTES les images, y compris celles servies par
 * les places de marché. C'est ce qui les cassait, et l'explication mérite
 * d'être écrite parce qu'elle n'a rien d'évident :
 *
 * Une balise `<img>` qui pointe vers un autre domaine émet une requête en
 * mode `no-cors`. La réponse est alors OPAQUE : le service worker la reçoit
 * avec un statut 0 et un corps illisible. Workbox refuse de mettre en cache
 * autre chose qu'un 200 ; `StaleWhileRevalidate` se retrouve donc sans rien
 * à rendre — ni cache, ni réponse jugée valide — et l'image échoue.
 *
 * Le paradoxe est que le service worker cassait précisément ce qu'il devait
 * accélérer, et qu'il ne le faisait que sur les images distantes : les
 * nôtres, même origine, passaient sans encombre. D'où le diagnostic trompeur
 * — le CDN d'Alibaba répondait parfaitement en ligne de commande.
 *
 * On laisse donc les images distantes aller au réseau sans interception. Le
 * navigateur les met en cache lui-même, avec les en-têtes du serveur.
 */
registerRoute(
  ({ request, url }) =>
    request.destination === "image" && url.origin === self.location.origin,
  new StaleWhileRevalidate({
    // Nom changé à dessein : l'ancien cache contient des échecs mémorisés,
    // et les servir à nouveau reconduirait la panne après la mise à jour.
    cacheName: "images-v2",
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
