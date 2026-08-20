#!/usr/bin/env node
/**
 * Provisionnement et déploiement complets, en une commande.
 *
 *   node scripts/deploy.mjs
 *
 * Prérequis : être connecté à Cloudflare (`pnpm exec wrangler login`).
 *
 * Le script est IDEMPOTENT : le relancer ne crée pas de doublons et ne
 * détruit rien. Il peut être interrompu et repris.
 *
 * Ce qu'il fait, dans l'ordre :
 *   1. vérifie l'authentification
 *   2. crée la base D1, l'espace KV et les deux files d'attente si absents
 *   3. inscrit les identifiants obtenus dans wrangler.jsonc
 *   4. construit la PWA
 *   5. déploie une première fois pour découvrir l'URL workers.dev
 *   6. inscrit cette URL dans APP_URL, envoie les secrets, applique les migrations
 *   7. redéploie avec la configuration définitive
 *
 * Les deux déploiements ne sont pas un gaspillage : l'URL n'est connue
 * qu'après le premier, et APP_URL sert à calculer les adresses de rappel
 * OAuth ainsi que l'identifiant de domaine WebAuthn. Une valeur fausse fait
 * échouer la connexion sans message clair.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(ROOT, "wrangler.jsonc");
const SECRETS = path.join(ROOT, ".secrets.generated.json");

const DB_NAME = "market-hub-db";
const KV_BINDING = "CACHE";
const QUEUE_MAIN = "market-hub-sync";
const QUEUE_DLQ = "market-hub-dlq";

/* --------------------------------------------------------------- */

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

let step = 0;
const say = (msg) => console.log(`\n${c.b(`[${++step}]`)} ${msg}`);
const info = (msg) => console.log(`    ${c.dim(msg)}`);
const good = (msg) => console.log(`    ${c.ok("✓")} ${msg}`);

/**
 * Lance wrangler et renvoie ses DEUX flux concaténés.
 *
 * spawnSync et non execFileSync : ce dernier ne rend que la sortie standard,
 * or wrangler écrit une partie de ses messages — dont « You are not
 * authenticated » — sur la sortie d'erreur, tout en terminant avec le code 0.
 * Une garde qui ne lit que stdout ne voit donc jamais l'échec
 * d'authentification et laisse le script continuer jusqu'à planter plus loin.
 *
 * `soft` tolère un code de retour non nul (ressource déjà existante, etc.).
 */
const WRANGLER_JS = path.join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const VITE_JS = path.join(ROOT, "apps/web/node_modules/vite/bin/vite.js");

function wrangler(args, { soft = false, quiet = true } = {}) {
  // On lance l'entrée JavaScript avec le Node courant, sans passer par
  // `pnpm.cmd` : depuis la CVE-2024-27980, Node refuse de démarrer un `.cmd`
  // sans `shell: true`, et spawnSync échoue silencieusement (status null,
  // flux vides) — ce qui faisait passer la garde d'authentification.
  const r = spawnSync(process.execPath, [WRANGLER_JS, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
  });
  if (r.error) {
    console.error(c.err(`\nImpossible de lancer wrangler : ${r.error.message}`));
    process.exit(1);
  }
  const out = quiet ? (r.stdout ?? "") + (r.stderr ?? "") : "";
  if (r.status !== 0 && !soft) {
    console.error(c.err("\nÉchec de : wrangler " + args.join(" ")));
    console.error(out);
    process.exit(1);
  }
  return out;
}

/** Extrait le tableau JSON d'une sortie wrangler polluée par sa bannière. */
function jsonArray(raw) {
  const a = raw.indexOf("[");
  const b = raw.lastIndexOf("]");
  return a === -1 || b === -1 ? [] : JSON.parse(raw.slice(a, b + 1));
}

/** Remplace une valeur dans wrangler.jsonc sans reformater le fichier. */
function patchConfig(find, replace) {
  const before = readFileSync(CONFIG, "utf8");
  if (!before.includes(find)) return false;
  writeFileSync(CONFIG, before.replaceAll(find, replace), "utf8");
  return true;
}

function readConfig() {
  return readFileSync(CONFIG, "utf8");
}

/* --------------------------------------------------------------- */

console.log(c.b("\n  MarketHub — provisionnement et déploiement Cloudflare\n"));

/* 1 — authentification ------------------------------------------- */
say("Vérification de la session Cloudflare");
const who = wrangler(["whoami"], { soft: true });
if (/not authenticated/i.test(who)) {
  console.error(c.err("\n    Vous n'êtes pas connecté à Cloudflare."));
  console.error("    Lancez d'abord :  pnpm exec wrangler login");
  console.error("    (une page s'ouvre dans le navigateur, autorisez l'accès)\n");
  process.exit(1);
}
const account = who.match(/│\s*([^│]+?)\s*│\s*([0-9a-f]{32})\s*│/);
good(account ? `compte « ${account[1].trim()} »` : "session active");

/* 2 — base de données D1 ----------------------------------------- */
say("Base de données D1");
if (readConfig().includes("REMPLACER_APRES_wrangler_d1_create")) {
  wrangler(["d1", "create", DB_NAME], { soft: true }); // tolère « existe déjà »

  const list = jsonArray(wrangler(["d1", "list", "--json"]));
  const db = list.find((d) => d.name === DB_NAME);
  if (!db) {
    console.error(c.err(`    Base « ${DB_NAME} » introuvable après création.`));
    process.exit(1);
  }
  patchConfig("REMPLACER_APRES_wrangler_d1_create", db.uuid);
  good(`${DB_NAME} — ${db.uuid}`);
} else {
  good("déjà configurée dans wrangler.jsonc");
}

/* 3 — espace KV --------------------------------------------------- */
say("Espace KV (états OAuth, compteurs)");
if (readConfig().includes("REMPLACER_APRES_wrangler_kv_namespace_create")) {
  wrangler(["kv", "namespace", "create", KV_BINDING], { soft: true });

  const raw = wrangler(["kv", "namespace", "list"]);
  const spaces = jsonArray(raw);
  // wrangler préfixe le titre du nom du Worker : « market-hub-CACHE ».
  const ns =
    spaces.find((n) => n.title.endsWith(`-${KV_BINDING}`)) ??
    spaces.find((n) => n.title === KV_BINDING);
  if (!ns) {
    console.error(c.err("    Espace KV introuvable après création."));
    process.exit(1);
  }
  patchConfig("REMPLACER_APRES_wrangler_kv_namespace_create", ns.id);
  good(`${ns.title} — ${ns.id}`);
} else {
  good("déjà configuré dans wrangler.jsonc");
}

/* 4 — files d'attente --------------------------------------------- */
say("Files d'attente");
for (const q of [QUEUE_MAIN, QUEUE_DLQ]) {
  const out = wrangler(["queues", "create", q], { soft: true });
  if (/already exists/i.test(out)) good(`${q} — existait déjà`);
  else good(`${q} — créée`);
}

/* 5 — construction de la PWA -------------------------------------- */
say("Construction de la PWA");
{
  // Vite lancé directement, pour la même raison que wrangler ci-dessus.
  const r = spawnSync(process.execPath, [VITE_JS, "build"], {
    cwd: path.join(ROOT, "apps/web"),
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error(c.err("\n    La construction de la PWA a échoué."));
    process.exit(1);
  }
}
good("apps/web/dist prêt");

/* 6 — premier déploiement, pour découvrir l'URL -------------------- */
say("Déploiement initial");

const URL_RE = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i;
let out1 = wrangler(["deploy"], { soft: true });
let url = (out1.match(URL_RE) ?? [])[0];

/**
 * Premier déploiement d'un compte neuf : Cloudflare exige d'enregistrer un
 * sous-domaine *.workers.dev, une seule fois pour tout le compte. Wrangler le
 * demande par une invite — à laquelle un script non interactif répond « non »,
 * puis échoue. On repasse donc la main à l'utilisateur pour cette question
 * précise, au lieu de le laisser devant un message opaque.
 */
if (!url && /register (a )?workers\.dev subdomain/i.test(out1)) {
  console.log(c.warn("\n    Votre compte n'a pas encore de sous-domaine workers.dev."));
  console.log("    C'est une inscription unique. Wrangler va vous la proposer :");
  console.log(c.dim("    répondez « y », puis choisissez un nom (ex. votre pseudo).\n"));

  wrangler(["deploy"], { quiet: false }); // interactif : l'invite s'affiche
  out1 = wrangler(["deploy"], { soft: true }); // relance pour capter l'URL
  url = (out1.match(URL_RE) ?? [])[0];
}

if (!url) {
  console.error(c.err("\n    URL workers.dev introuvable dans la sortie."));
  console.error(c.dim(out1.split("\n").slice(-12).join("\n")));
  console.error("\n    Si le déploiement a réussi, relevez l'URL manuellement,");
  console.error("    inscrivez-la dans wrangler.jsonc → vars.APP_URL, puis relancez.");
  process.exit(1);
}
good(`en ligne : ${url}`);

/* 7 — APP_URL ------------------------------------------------------ */
say("Inscription de l'URL dans la configuration");
const placeholder = "https://market-hub.VOTRE-SOUS-DOMAINE.workers.dev";
if (patchConfig(placeholder, url)) good(`APP_URL = ${url}`);
else good("APP_URL déjà renseignée");

/* 8 — secrets ------------------------------------------------------ */
say("Envoi des secrets");
if (!existsSync(SECRETS)) {
  console.error(c.err("    .secrets.generated.json introuvable."));
  process.exit(1);
}
const secrets = JSON.parse(readFileSync(SECRETS, "utf8"));
// VAPID_SUBJECT : adresse de contact transmise aux services de push (Apple,
// Google) pour vous joindre en cas d'abus. Changez-la si vous préférez.
secrets.VAPID_SUBJECT ??= "mailto:maxime.bicchierai@gmail.com";

const tmp = path.join(ROOT, ".secrets.bulk.json");
writeFileSync(tmp, JSON.stringify(secrets), "utf8");
try {
  wrangler(["secret", "bulk", tmp]);
  good(`${Object.keys(secrets).length} secrets envoyés`);
} finally {
  // Écrasé avant suppression : le contenu ne doit pas survivre dans un
  // secteur libéré si la suppression échoue.
  writeFileSync(tmp, "{}", "utf8");
  rmSync(tmp, { force: true });
}

/* 9 — migrations --------------------------------------------------- */
say("Application des migrations D1");
const mig = wrangler(["d1", "migrations", "apply", DB_NAME, "--remote"], { soft: true });
if (/No migrations to apply/i.test(mig)) good("schéma déjà à jour");
else good("schéma appliqué");

/* 10 — déploiement définitif --------------------------------------- */
say("Déploiement définitif");
wrangler(["deploy"], { quiet: false });

console.log(`
${c.ok("  ══════════════════════════════════════════════════")}
${c.ok("  En ligne, 24 h/24")}

  ${c.b(url)}

  Ouvrez cette adresse, créez votre accès par clé d'accès,
  puis ajoutez l'app à l'écran d'accueil du téléphone.

  Vérification rapide :  ${url}/api/health
${c.ok("  ══════════════════════════════════════════════════")}
`);
