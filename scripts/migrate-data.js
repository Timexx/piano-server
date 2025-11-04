#!/usr/bin/env node

/**
 * One-time data migration helper.
 *
 * Usage:
 *   node scripts/migrate-data.js
 *
 * The script will:
 *   1. Initialise the auth service (creates auth.sqlite if missing).
 *   2. Run the data-store migration which imports config.json / playlists.json
 *      and registers every PDF under sheets/ for the initial admin user.
 *   3. Print a summary with the location of the migrated files and backup copies.
 *
 * The migration is idempotent – after it runs successfully once, it records a
 * marker in the `migrations` table and exits early on subsequent runs.
 */

const path = require("path");
const { createAuthService } = require("../lib/auth");
const { createDataStore } = require("../lib/data-store");

async function main() {
  const ROOT = path.join(__dirname, "..");
  const DATA_DIR = path.join(ROOT, "data");
  const SHEETS_DIR = path.join(ROOT, "sheets");

  const authService = await createAuthService({ dataDir: DATA_DIR, logger: console });
  const dataStore = await createDataStore({
    authService,
    dataDir: DATA_DIR,
    sheetsDir: SHEETS_DIR,
    logger: console,
  });

  await dataStore.ensureInitialMigration();
  console.log("✔ Migration finished. Check data/auth.sqlite for imported data.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
});
