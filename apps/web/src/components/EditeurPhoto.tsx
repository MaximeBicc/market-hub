import { useEffect, useRef, useState } from "react";
import { toast } from "./Toast.js";

/**
 * RECADRER UNE PHOTO SANS QUITTER MARKETHUB.
 *
 * Ce que demandait la consigne écrite pour ChatGPT — « format carré, cadrage
 * centré, haute définition, lumière homogène » — se fait ici sans IA, sans
 * compte et sans réseau : quatre transformations déterministes que le
 * navigateur sait faire seul.
 *
 * POURQUOI PAS D'IA. Le seul modèle image-à-image gratuit disponible n'a que
 * deux régimes sur une photo produit : trop faible, il ne change rien ; assez
 * fort, il RÉINVENTE l'objet. Une fiche qui montre un article différent de
 * celui qu'on livre est un litige acheteur, pas une retouche. Le fond et le
 * filigrane restent donc au lien ChatGPT, où un humain juge du résultat.
 *
 * Le canevas travaille sur l'image servie par NOTRE proxy : une image d'un
 * autre domaine « souille » le canevas et son export échoue — un défaut qui
 * ne se voit qu'au moment d'enregistrer.
 */
export function EditeurPhoto({
  source,
  onFini,
  onFermer,
}: {
  /** L'adresse à charger — passer par le proxy, jamais l'originale. */
  source: string;
  /** Rendue avec l'adresse publique de la photo enregistrée. */
  onFini: (url: string) => void;
  onFermer: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const [prete, setPrete] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const [zoom, setZoom] = useState(1);
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [lumiere, setLumiere] = useState(100);
  const [taille, setTaille] = useState(1600);
  const [envoi, setEnvoi] = useState(false);

  /** Le canevas d'aperçu reste petit ; l'export se fait à la taille voulue. */
  const APERCU = 320;

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      image.current = img;
      setPrete(true);
    };
    img.onerror = () =>
      setErreur(
        "Image illisible. Elle doit être servie par MarketHub pour pouvoir être recadrée.",
      );
    img.src = source;
  }, [source]);

  /** Dessine l'image dans un carré, à l'échelle et au décalage choisis. */
  function dessiner(cible: HTMLCanvasElement, cote: number) {
    const img = image.current;
    if (!img) return;
    const ctx = cible.getContext("2d");
    if (!ctx) return;

    cible.width = cote;
    cible.height = cote;

    // Fond blanc : un JPEG n'a pas de transparence, et sans fond explicite
    // les bords non couverts sortiraient en noir.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cote, cote);
    ctx.filter = `brightness(${lumiere}%)`;

    /*
     * « Couvrir » et non « contenir » : on remplit le carré quitte à rogner.
     * Une photo produit avec deux bandes blanches sur les côtés paraît
     * bâclée, et les plateformes la recadrent elles-mêmes, sans demander.
     */
    const echelle = (cote / Math.min(img.width, img.height)) * zoom;
    const l = img.width * echelle;
    const h = img.height * echelle;
    ctx.drawImage(
      img,
      (cote - l) / 2 + dx * cote,
      (cote - h) / 2 + dy * cote,
      l,
      h,
    );
    ctx.filter = "none";
  }

  useEffect(() => {
    if (prete && canvas.current) dessiner(canvas.current, APERCU);
  }, [prete, zoom, dx, dy, lumiere]);

  async function enregistrer() {
    if (!image.current) return;
    setEnvoi(true);
    try {
      const sortie = document.createElement("canvas");
      dessiner(sortie, taille);

      const blob = await new Promise<Blob | null>((res) =>
        // 0,92 : au-delà le poids grimpe sans gain visible sur une photo.
        sortie.toBlob((b) => res(b), "image/jpeg", 0.92),
      );
      if (!blob) throw new Error("Export impossible");

      const r = await fetch("/api/media", {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: blob,
        credentials: "same-origin",
      });
      const d = (await r.json()) as { url?: string; error?: string };
      if (!r.ok || !d.url) throw new Error(d.error ?? "Enregistrement refusé");

      onFini(d.url);
      toast("Photo enregistrée et ajoutée à vos photos");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Échec de l'enregistrement");
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <div className="editeur-fond" onClick={onFermer}>
      <div className="editeur" onClick={(e) => e.stopPropagation()}>
        <div className="editeur__tete">
          <b>Recadrer la photo</b>
          <button type="button" className="btn btn--small btn--ghost" onClick={onFermer}>
            Fermer
          </button>
        </div>

        {erreur ? (
          <p className="row__s" style={{ whiteSpace: "normal" }}>{erreur}</p>
        ) : (
          <>
            <div className="editeur__scene">
              <canvas ref={canvas} width={APERCU} height={APERCU} />
            </div>

            <label className="editeur__reglage">
              <span>Zoom</span>
              <input type="range" min="1" max="3" step="0.02"
                value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
            </label>
            <label className="editeur__reglage">
              <span>Horizontal</span>
              <input type="range" min="-0.5" max="0.5" step="0.01"
                value={dx} onChange={(e) => setDx(Number(e.target.value))} />
            </label>
            <label className="editeur__reglage">
              <span>Vertical</span>
              <input type="range" min="-0.5" max="0.5" step="0.01"
                value={dy} onChange={(e) => setDy(Number(e.target.value))} />
            </label>
            <label className="editeur__reglage">
              <span>Lumière</span>
              <input type="range" min="60" max="160" step="1"
                value={lumiere} onChange={(e) => setLumiere(Number(e.target.value))} />
            </label>
            <label className="editeur__reglage">
              <span>Définition</span>
              <select className="input" value={taille}
                onChange={(e) => setTaille(Number(e.target.value))}>
                <option value={1000}>1000 px — minimum d'Etsy</option>
                <option value={1600}>1600 px — recommandé</option>
                <option value={2000}>2000 px — zoom d'eBay</option>
              </select>
            </label>

            <button
              type="button"
              className="btn btn--primary btn--wide"
              disabled={!prete || envoi}
              onClick={() => void enregistrer()}
            >
              {envoi ? "Enregistrement…" : "Enregistrer dans mes photos"}
            </button>
            <p className="row__s" style={{ whiteSpace: "normal", marginTop: 8 }}>
              La photo est hébergée par MarketHub et servie aux trois boutiques.
              Le fond et le filigrane ne se traitent pas ici : utilisez
              « ChatGPT » pour ça, puis collez l'adresse du résultat.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
