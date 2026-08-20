import { useEffect, useState } from "react";

/**
 * Message éphémère, déclenché de n'importe où par un événement.
 *
 * Passer par un événement plutôt que par un contexte React évite de faire
 * remonter un état partagé jusqu'à la racine pour un usage aussi ponctuel.
 */
export function toast(message: string) {
  window.dispatchEvent(new CustomEvent("toast", { detail: message }));
}

export function Toast() {
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const handler = (e: Event) => {
      setMsg((e as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 3200);
    };
    window.addEventListener("toast", handler);
    return () => {
      window.removeEventListener("toast", handler);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className="toast" data-show={msg !== null} role="status" aria-live="polite">
      {msg}
    </div>
  );
}
