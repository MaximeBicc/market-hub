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
  check: <><path d="m5 13 4 4L19 7" /></>,
  checkCircle: <><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  truck: <><rect x="1" y="5" width="15" height="11" rx="1.5" /><path d="M16 8h4l3 3.5V16h-7V8Z" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
  tag: <><path d="M12 2H2v10l9.5 9.5a2.12 2.12 0 0 0 3 0l6.5-6.5a2.12 2.12 0 0 0 0-3L12 2Z" /><circle cx="7" cy="7" r="1.5" /></>,
  printer: <><path d="M6 9V3h12v6" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="7" rx="1" /></>,
  link: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  minus: <><path d="M5 12h14" /></>,
  chevronRight: <><path d="m9 18 6-6-6-6" /></>,
  chevronLeft: <><path d="m15 18-6-6 6-6" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></>,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></>,
  pencil: <><path d="M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z" /><path d="M14.5 6.5 17.5 9.5" /></>,
  close: <><path d="M18 6 6 18M6 6l12 12" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
