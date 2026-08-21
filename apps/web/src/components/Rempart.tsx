import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * REMPART — un morceau qui casse ne doit pas emporter l'écran.
 *
 * Sans lui, React démonte tout l'arbre au premier accroc et laisse une page
 * noire, sans message, sans bouton, sans indice. C'est arrivé : un résultat
 * d'analyse produit par une version antérieure ne portait pas un champ que le
 * nouvel écran lisait, et l'application entière a disparu — alors que tout le
 * reste fonctionnait parfaitement.
 *
 * Une page noire est le pire des échecs. Elle ne dit pas ce qui manque, ne
 * suggère rien, et laisse croire que l'application est morte. Un encart qui
 * dit « ce résultat ne s'affiche pas, voici pourquoi, voici quoi faire » vaut
 * infiniment mieux, même s'il est moins joli.
 *
 * Ce composant doit rester une classe : React n'offre aucun équivalent en
 * fonction pour attraper une erreur de rendu.
 */
export class Rempart extends Component<
  { children: ReactNode; recours?: ReactNode },
  { erreur: Error | null }
> {
  override state: { erreur: Error | null } = { erreur: null };

  static getDerivedStateFromError(erreur: Error) {
    return { erreur };
  }

  override componentDidCatch(erreur: Error, info: ErrorInfo) {
    // Le détail part dans la console : l'écran reste lisible, le diagnostic
    // reste possible.
    console.error("Rempart a intercepté une erreur d'affichage", erreur, info.componentStack);
  }

  override render() {
    if (!this.state.erreur) return this.props.children;

    return (
      <div className="banner banner--stop" style={{ margin: 0 }}>
        <div>
          <div className="banner__t">Ce résultat ne peut pas être affiché</div>
          <div className="banner__b">
            Il a probablement été produit par une version antérieure de
            l'analyse, dont la forme a changé depuis. Relancez-la : le nouveau
            résultat s'affichera normalement.
            <div style={{ marginTop: 8, fontFamily: "var(--mono)", fontSize: 10.5, opacity: 0.8 }}>
              {String(this.state.erreur.message).slice(0, 160)}
            </div>
          </div>
          {this.props.recours}
        </div>
      </div>
    );
  }
}
