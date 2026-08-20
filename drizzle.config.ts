import { defineConfig } from "drizzle-kit";

/**
 * Génération des migrations SQL à partir du schéma TypeScript.
 *
 *   pnpm db:generate            -> écrit un fichier dans apps/worker/migrations
 *   pnpm db:migrate:local       -> applique sur la base D1 locale
 *   pnpm db:migrate:remote      -> applique en production
 *
 * On ne modifie jamais une migration déjà appliquée : on en ajoute une nouvelle.
 */
export default defineConfig({
  schema: "./apps/worker/src/db/schema.ts",
  out: "./apps/worker/migrations",
  dialect: "sqlite",
  driver: "d1-http",
});
