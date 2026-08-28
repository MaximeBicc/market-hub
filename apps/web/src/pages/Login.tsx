import { useState } from "react";
import { api } from "../lib/api.js";
import { PalmLoader } from "../components/PalmLoader.js";

/**
 * Connexion par identifiant et mot de passe.
 *
 * Deux comptes existent, créés côté serveur. Il n'y a volontairement aucune
 * page d'inscription : pour un outil privé à deux, elle ne serait qu'une
 * surface d'attaque supplémentaire.
 *
 * `autoComplete="username"` et `"current-password"` ne sont pas décoratifs :
 * ils permettent aux gestionnaires de mots de passe du téléphone de proposer
 * le remplissage, ce qui est la seule façon réaliste de saisir un mot de passe
 * aléatoire de 24 caractères sur un écran tactile.
 */
export function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/login", { username, password });
      window.location.href = "/";
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Connexion impossible.",
      );
      setBusy(false);
    }
  }

  if (busy) {
    return <PalmLoader fullscreen label="Connexion à MarketHub…" />;
  }

  return (
    <div className="login">
      <form className="login__box" onSubmit={submit}>
        <img className="login__logo" src="/icons/icon-192.png" alt="" />
        <h1 className="login__n">MarketHub</h1>
        <p className="login__s">Vos boutiques, au même endroit.</p>

        {error && <div className="login__err">{error}</div>}

        <div className="field">
          <label htmlFor="u">Identifiant</label>
          <input
            id="u"
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="p">Mot de passe</label>
          <input
            id="p"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>

        <button
          type="submit"
          className="btn btn--primary btn--wide"
          disabled={!username || !password}
          style={{ marginTop: 4 }}
        >
          Se connecter
        </button>
      </form>
    </div>
  );
}
