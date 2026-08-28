interface PalmLoaderProps {
  label?: string;
  /** Remplit toute la fenêtre, notamment pendant l'amorçage et la connexion. */
  fullscreen?: boolean;
  /** Version contenue pour les cartes, listes et fenêtres modales. */
  compact?: boolean;
}

/**
 * Indicateur de chargement commun à toute l'application.
 *
 * Le palmier est un SVG local : il s'affiche immédiatement, même avec une
 * connexion lente, et ne peut pas bloquer le chargement qu'il accompagne.
 */
export function PalmLoader({
  label = "Chargement…",
  fullscreen = false,
  compact = false,
}: PalmLoaderProps) {
  const classes = [
    "palm-loader",
    fullscreen ? "palm-loader--fullscreen" : "",
    compact ? "palm-loader--compact" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} role="status" aria-live="polite" aria-label={label}>
      <div className="palm-loader__scene" aria-hidden="true">
        <span className="palm-loader__halo" />
        <svg className="palm-loader__palm" viewBox="0 0 120 120">
          <ellipse className="palm-loader__shadow" cx="60" cy="101" rx="27" ry="5" />
          <g className="palm-loader__tree">
            <path
              className="palm-loader__trunk"
              d="M58 99c2-14 1-27 2-39 .5-8 2-14 4-20"
            />
            <g className="palm-loader__leaves">
              <path d="M64 43C53 28 38 23 23 28c14 2 28 8 40 18Z" />
              <path d="M64 43C61 26 52 15 40 10c8 10 15 23 22 37Z" />
              <path d="M64 43C66 25 73 14 84 8c-4 13-10 26-18 39Z" />
              <path d="M65 43c13-12 29-14 42-8-14 3-27 7-41 12Z" />
              <path d="M63 44c-15-3-27 2-35 13 13-5 25-7 38-9Z" />
              <path d="M65 44c15 0 26 7 32 18-11-6-22-10-33-14Z" />
              <circle cx="64" cy="45" r="4" />
            </g>
          </g>
        </svg>
      </div>

      <span className="palm-loader__label">{label}</span>
      <span className="palm-loader__dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
