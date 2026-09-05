import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config (tasks.md T075). `db:generate` writes SQL migrations from src/db/schema.ts
 * into src/db/migrations; `db:migrate` applies them to DATABASE_URL (the Hyperdrive origin
 * Postgres, run from a developer machine / CI, never from the Worker).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@127.0.0.1:5432/truecollective",
  },
  strict: true,
  verbose: true,
});
