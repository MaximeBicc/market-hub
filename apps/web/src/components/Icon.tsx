/**
 * Jeu d'icônes en SVG inline.
 *
 * Pas de bibliothèque : une dizaine de traits pèsent moins qu'un paquet de
 * plusieurs centaines de kilo-octets, et la CSP interdit tout script externe.
 * `currentColor` fait que chaque icône prend la couleur de son contexte.
 */
const PATHS = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.8V20h14V9.8" /></>,
  orders: <><path d="M5 7h14l-1 13H6L5 7Z" /><path d="M9 7V5.5a3 3 0 0 1 6 0V7" /></>,
  box: <><path d="M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16V8Z" /><path d="M3.5 8 12 12.5 20.5 8" /><path d="M12 12.5v8" /></>,
  chart: <><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></>,
  shops: <><path d="M4 9h16l-1 11H5L4 9Z" /><path d="M4 9 5.6 4h12.8L20 9" /><path d="M9.5 13a2.5 2.5 0 0 0 5 0" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2 5.6 5.6" /></>,
  plug: <><path d="M9 3v6" /><path d="M15 3v6" /><path d="M6 9h12v3a6 6 0 0 1-12 0V9Z" /><path d="M12 18v3" /></>,
  bell: <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" /><path d="M10 19a2 2 0 0 0 4 0" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-1.6 5.4" /><path d="M20 5v6h-6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5.2l3.2 2" /></>,
  sparkle: <><path d="M12 3.5 13.8 9 19 10.5 13.8 12 12 17.5 10.2 12 5 10.5 10.2 9 12 3.5Z" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
