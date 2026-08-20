import { useState } from "react";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { api } from "../lib/api.js";

/**
 * Connexion par clé d'accès.
 *
 * Aucun mot de passe n'est demandé ni stocké nulle part. Sur téléphone, le
 * navigateur déclenche Face ID ou l'empreinte ; sur ordinateur, Windows Hello
 * ou Touch ID.
 *
 * Le premier enregistrement crée le compte. Ensuite, seul le bouton de
 * connexion reste visible.
 */
export function Login({ initialized }: { initialized: boolean }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function register() {
    setBusy(true);
    setError(null);
    try {
      const options = await api.post<{ challenge: string }>(
        "/auth/register/options",
        { email },
      );
      const response = await startRegistration({ optionsJSON: options as never });
      await api.post("/auth/register/verify", {
        response,
        challenge: options.challenge,
        label: navigator.userAgent.slice(0, 60),
      });
      window.location.href = "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec de l'enregistrement");
    } finally {
      setBusy(false);
    }
  }

  async function login() {
    setBusy(true);
    setError(null);
    try {
      const options = await api.post<{ challenge: string }>("/auth/login/options");
      const response = await startAuthentication({
        optionsJSON: options as never,
      });
      await api.post("/auth/login/verify", {
        response,
        challenge: options.challenge,
      });
      window.location.href = "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec de la connexion");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <h1>MarketHub</h1>
      <p className="muted">Vos boutiques, au même endroit.</p>

      {initialized ? (
        <button className="btn btn--primary" onClick={login} disabled={busy}>
          Se connecter
        </button>
      ) : (
        <>
          <input
            type="email"
            placeholder="votre@email.fr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
          />
          <button
            className="btn btn--primary"
            onClick={register}
            disabled={busy || !email}
          >
            Créer mon accès
          </button>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
