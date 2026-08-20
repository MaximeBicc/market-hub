import { Icon, type IconName } from "./Icon.js";

/**
 * État vide.
 *
 * Un écran vide doit dire POURQUOI il l'est et QUOI faire. Un tableau vide
 * sans explication ressemble à une panne, et c'est le premier réflexe de
 * l'utilisateur : croire que l'outil est cassé.
 *
 * `planned` distingue deux vides très différents :
 *   - la section fonctionne mais n'a pas encore de données ;
 *   - la section n'est pas encore construite.
 * Les confondre serait mentir sur l'état du produit.
 */
export function Empty({
  icon = "box",
  title,
  children,
  action,
  planned = false,
}: {
  icon?: IconName;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  planned?: boolean;
}) {
  return (
    <div className={planned ? "empty planned" : "empty"}>
      <span className="empty__i">
        <Icon name={icon} />
      </span>
      <span className="empty__t">{title}</span>
      {children && <p className="empty__d">{children}</p>}
      {action}
    </div>
  );
}
