/**
 * Abonnement aux notifications push, côté navigateur.
 *
 * Toute la complexité tient dans une phrase : sur iPhone, le push n'existe que
 * si l'application a été AJOUTÉE À L'ÉCRAN D'ACCUEIL et lancée depuis son
 * icône. Dans Safari, `window.PushManager` est absent et toute demande de
 * permission échoue. Il faut iOS 16.4 ou plus.
 *
 * D'où l'ordre des vérifications ci-dessous : on détecte le cas iOS-non-installé
 * en PREMIER, pour afficher « Ajoutez l'app à votre écran d'accueil » plutôt
 * qu'une erreur incompréhensible.
 */

export type PushStatus =
  | { state: "ready" }
  | { state: "needs-install"; reason: string }
  | { state: "unsupported"; reason: string }
  | { state: "denied"; reason: string }
  | { state: "not-subscribed" };

/** L'app tourne-t-elle en mode installé (écran d'accueil) ? */
export function isInstalled(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // Propriété non standard, propre à Safari iOS.
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export async function checkPushStatus(): Promise<PushStatus> {
  if (!("serviceWorker" in navigator)) {
    return { state: "unsupported", reason: "Service worker indisponible" };
  }

  if (!("PushManager" in window)) {
    if (isIOS() && !isInstalled()) {
      return {
        state: "needs-install",
        reason:
          "Sur iPhone, touchez Partager puis « Sur l'écran d'accueil », et rouvrez l'app depuis son icône.",
      };
    }
    return { state: "unsupported", reason: "Push non supporté par ce navigateur" };
  }

  if (Notification.permission === "denied") {
    return {
      state: "denied",
      reason: "Notifications bloquées dans les réglages du navigateur.",
    };
  }

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? { state: "ready" } : { state: "not-subscribed" };
}

/**
 * Demande la permission et enregistre l'abonnement côté serveur.
 * ⚠️ Doit être appelé depuis un geste utilisateur (clic sur un bouton) :
 * les navigateurs refusent une demande de permission spontanée.
 */
export async function subscribeToPush(): Promise<PushStatus> {
  const status = await checkPushStatus();
  if (status.state !== "not-subscribed" && status.state !== "ready") return status;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { state: "denied", reason: "Permission refusée." };
  }

  const { key } = await fetch("/api/push/key").then((r) => r.json());
  const reg = await navigator.serviceWorker.ready;

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true, // obligatoire : pas de push silencieux sur le web
    applicationServerKey: urlBase64ToUint8Array(key),
  });

  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });

  return { state: "ready" };
}

/**
 * La clé VAPID publique voyage en base64url ; l'API la veut en octets.
 * Type de retour explicite en `Uint8Array<ArrayBuffer>` : `applicationServerKey`
 * exige un vrai ArrayBuffer, pas un ArrayBufferLike.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
