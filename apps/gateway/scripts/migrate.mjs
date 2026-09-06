import { spawnSync } from "node:child_process";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required: set it to the direct PostgreSQL origin connection string used to create the Hyperdrive config",
  );
}

const result = spawnSync("drizzle-kit", ["migrate"], {
  env: process.env,
  stdio: "inherit",
});

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
