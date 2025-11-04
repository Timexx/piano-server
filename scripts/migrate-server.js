#!/usr/bin/env node
// scripts/migrate-server.js
// Automatisches Migrations-Skript für Server-Refactoring

const fs = require("fs");
const path = require("path");

const SERVER_FILE = path.join(__dirname, "..", "server.js");
const BACKUP_FILE = path.join(__dirname, "..", "server.js.backup");

console.log("🔧 Piano Server Refactoring Migration");
console.log("=====================================\n");

// Backup erstellen
console.log("1. Creating backup...");
try {
  fs.copyFileSync(SERVER_FILE, BACKUP_FILE);
  console.log(`   ✓ Backup created: ${BACKUP_FILE}\n`);
} catch (err) {
  console.error("   ✗ Failed to create backup:", err.message);
  process.exit(1);
}

// Server.js einlesen
console.log("2. Reading server.js...");
let content;
try {
  content = fs.readFileSync(SERVER_FILE, "utf8");
  console.log(`   ✓ Read ${content.length} bytes\n`);
} catch (err) {
  console.error("   ✗ Failed to read server.js:", err.message);
  process.exit(1);
}

console.log("3. Applying transformations...\n");

// Transformation 1: Entferne alte User-Context Definitionen (Zeilen ~1189-1328)
console.log("   • Removing old user context proxy definitions...");
const oldProxyPattern = /\/\* ---------------- User-scoped config & playlists.*?\*\/\s*const DEFAULT_CONFIG[\s\S]*?const PLAYLIST_STATE = new Proxy\({}\, \{[\s\S]*?\}\);/m;
if (oldProxyPattern.test(content)) {
  content = content.replace(oldProxyPattern, "// Old user context code removed - now handled by lib/user-context-middleware.js");
  console.log("     ✓ Removed old proxy definitions");
} else {
  console.log("     ℹ Old proxy definitions not found (might be already removed)");
}

// Transformation 2: Entferne alte SSE Client Sets
console.log("   • Removing old SSE client sets...");
content = content.replace(
  /const playlistActiveClients = new (Set|Map)\(\);?\s*const playlistStateClients = new (Set|Map)\(\);?/g,
  "// Old SSE clients removed - now handled by lib/user-sse-manager.js"
);
console.log("     ✓ Removed old SSE client declarations");

// Transformation 3: Update broadcastPlaylists function
console.log("   • Updating broadcastPlaylists function...");
const oldBroadcast = /function broadcastPlaylists\(\) \{[\s\S]*?for \(const res of playlistStateClients\)[\s\S]*?\}\s*\}/;
if (oldBroadcast.test(content)) {
  const newBroadcast = `function broadcastPlaylists() {
  // Broadcast to current user only
  const store = userContext?.getRequestContext();
  if (!store || !store.userId) return;
  
  try {
    const { PLAYLIST_STATE } = userContext;
    const activePayload = serializeActivePlaylist();
    const statePayload = serializePlaylistState(PLAYLIST_STATE);
    
    sseManager.broadcast(store.userId, "playlist-active", activePayload);
    sseManager.broadcast(store.userId, "playlist-state", statePayload);
  } catch (err) {
    console.error("Broadcast failed:", err);
  }
}`;
  content = content.replace(oldBroadcast, newBroadcast);
  console.log("     ✓ Updated broadcastPlaylists function");
} else {
  console.log("     ℹ broadcastPlaylists pattern not found");
}

// Transformation 4: Update old PLAYLIST_STATE definition
console.log("   • Removing old PLAYLIST_STATE loading...");
content = content.replace(
  /let PLAYLIST_STATE = loadPlaylists\(\);?\s*let _playlistSaveInProgress = null;?/g,
  "// Playlist state now managed per-user by userContext"
);
console.log("     ✓ Removed old PLAYLIST_STATE loading");

// Transformation 5: Kommentiere old helper functions aus
console.log("   • Marking old helper functions as deprecated...");
content = content.replace(
  /^async function ensureUserConfig\(/gm,
  "// DEPRECATED - now in lib/user-context-middleware.js\n// async function ensureUserConfig("
);
content = content.replace(
  /^async function ensureUserPlaylists\(/gm,
  "// DEPRECATED - now in lib/user-context-middleware.js\n// async function ensureUserPlaylists("
);
content = content.replace(
  /^async function flushConfigBeforeExit\(/gm,
  "// DEPRECATED - now handled by userContext.flushAllUserCaches()\n// async function flushConfigBeforeExit("
);
console.log("     ✓ Marked deprecated functions");

console.log("\n4. Writing modified server.js...");
try {
  fs.writeFileSync(SERVER_FILE, content, "utf8");
  console.log("   ✓ server.js updated successfully\n");
} catch (err) {
  console.error("   ✗ Failed to write server.js:", err.message);
  console.log("\nRestoring from backup...");
  fs.copyFileSync(BACKUP_FILE, SERVER_FILE);
  process.exit(1);
}

console.log("✅ Migration completed successfully!");
console.log("\nNext steps:");
console.log("1. Review the changes: git diff server.js");
console.log("2. Start the server: node server.js");
console.log("3. Test the application");
console.log("4. If issues occur, restore: cp server.js.backup server.js\n");
