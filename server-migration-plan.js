// server-migration-plan.js
// Schrittweiser Umbau-Plan für den Server

/*
 * MIGRATIONS-STRATEGIE
 * ===================
 * 
 * Da server.js mit 3513 Zeilen sehr groß ist, erfolgt der Umbau in Phasen:
 * 
 * PHASE 1: Initialisierung & Middleware (✅ Vorbereitet)
 * - authService und dataStore initialisieren
 * - userContextMiddleware einbinden
 * - sseManager erstellen
 * 
 * PHASE 2: Auth-Endpoints (Bereits korrekt, keine Änderung nötig)
 * - /api/auth/login
 * - /api/auth/logout  
 * - /api/auth/session
 * - /api/admin/users/*
 * 
 * PHASE 3: Config-Endpoints (CONFIG → userContext.CONFIG)
 * - /api/prefs (GET)
 * - /api/prefs/favorites (POST)
 * - /api/prefs/file (GET/POST)
 * - /api/categories (GET/POST/PUT/DELETE)
 * 
 * PHASE 4: Playlist-Endpoints (PLAYLIST_STATE → userContext.PLAYLIST_STATE)
 * - /api/playlists (GET)
 * - /api/playlists/events (GET) → SSE per user
 * - /api/playlist/events (GET) → SSE per user
 * - /api/playlists/* (POST/PATCH/DELETE)
 * - /api/playlist/* (POST) - Legacy endpoints
 * 
 * PHASE 5: Sheets & Upload (+ Document Management)
 * - /api/sheets (GET) - Filter nach User-Dokumenten
 * - /api/upload (POST) - Dokument registrieren
 * - DELETE endpoint hinzufügen - Ownership prüfen
 * 
 * PHASE 6: Annotations (Ownership prüfen)
 * - /api/annotations (GET/POST) - Zugriffsprüfung
 * - /api/annotations/save (POST)
 * - /api/annotations/undo (POST)
 * - /api/annotations/reset (POST)
 * 
 * WICHTIGE ÄNDERUNGEN PRO PHASE:
 */

// ============================================================================
// PHASE 1: Initialisierung (Nach Zeile ~3450 in server.js)
// ============================================================================
/*
// ÄNDERN VON:
let server = null;
let authService = null;
let dataStore = null;
let sheetWatcher = null;

// ZU:
let server = null;
let authService = null;
let dataStore = null;
let userContext = null;
let sseManager = null;
let sheetWatcher = null;

(async () => {
  try { await ensureVendors(); } catch { }
  
  try {
    authService = await createAuthService({ dataDir: DATA_DIR, logger: console });
    dataStore = await createDataStore({ authService, dataDir: DATA_DIR, sheetsDir: SHEETS_DIR, logger: console });
    await dataStore.ensureInitialMigration();
    
    // NEU: User-Context und SSE Manager
    const { createUserContextMiddleware } = require("./lib/user-context-middleware");
    const { UserSSEManager } = require("./lib/user-sse-manager");
    
    userContext = createUserContextMiddleware({ dataStore, logger: console });
    sseManager = new UserSSEManager({ logger: console });
    
    // Middleware NACH express.json() einfügen
    app.use(userContext.middleware);
    
  } catch (err) {
    console.error("Failed to initialize services:", err);
    process.exit(1);
  }
  
  sheetWatcher = initSheetWatcher();
  // ... rest bleibt gleich
})();
*/

// ============================================================================
// PHASE 2: Auth-Endpoints (Keine Änderung)
// ============================================================================
// Auth-Endpoints arbeiten direkt mit authService, brauchen keinen User-Context

// ============================================================================
// PHASE 3: Config-Endpoints
// ============================================================================
/*
// BEISPIEL für /api/prefs (Zeile ~2835):

// VORHER:
app.get("/api/prefs", async (req, res) => {
  await ensureConfigFresh();
  res.json(CONFIG);
});

// NACHHER:
app.get("/api/prefs", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { CONFIG } = userContext;
  res.setHeader("Cache-Control", "no-store");
  res.json(CONFIG);
});

// BEISPIEL für /api/prefs/favorites (Zeile ~2841):

// VORHER:
app.post("/api/prefs/favorites", async (req, res) => {
  // ... validation ...
  await ensureConfigFresh();
  const set = new Set(CONFIG.favorites);
  if (favorite) set.add(info.rel); else set.delete(info.rel);
  CONFIG.favorites = Array.from(set).sort(...);
  await persistConfigNow();
  res.json({ ok: true, favorites: CONFIG.favorites });
});

// NACHHER:
app.post("/api/prefs/favorites", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { CONFIG } = userContext;
  // ... validation ...
  const set = new Set(CONFIG.favorites);
  if (favorite) set.add(info.rel); else set.delete(info.rel);
  CONFIG.favorites = Array.from(set).sort(...);
  await userContext.persistConfigNow();
  res.json({ ok: true, favorites: CONFIG.favorites });
});

// MUSTER: Ersetze alle:
// - await ensureConfigFresh() → ENTFERNEN (macht Middleware)
// - CONFIG → userContext.CONFIG (oder über requireUserContext())
// - await persistConfigNow() → await userContext.persistConfigNow()
// - markConfigDirty() → userContext.markConfigDirty()
*/

// ============================================================================
// PHASE 4: Playlist-Endpoints & SSE
// ============================================================================
/*
// BEISPIEL für /api/playlists/events (Zeile ~1630):

// VORHER:
const playlistStateClients = new Set();
app.get("/api/playlists/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  // ...
  try { res.write(`data: ${JSON.stringify(serializePlaylistState(PLAYLIST_STATE))}\n\n`); } catch {}
  playlistStateClients.add(res);
  // ...
});

// NACHHER:
const { createSSEEndpoint } = require("./lib/user-sse-manager");
app.get("/api/playlists/events", createSSEEndpoint({
  manager: sseManager,
  channel: "playlist-state",
  requireAuth: true,
  initialData: (req) => {
    const { PLAYLIST_STATE } = userContext;
    return serializePlaylistState(PLAYLIST_STATE);
  },
}));

// Broadcast ändern:
// VORHER:
function broadcastPlaylists() {
  const activePayload = `data: ${JSON.stringify(serializeActivePlaylist())}\n\n`;
  const statePayload = `data: ${JSON.stringify(serializePlaylistState(PLAYLIST_STATE))}\n\n`;
  for (const res of playlistActiveClients) {
    try { res.write(activePayload); } catch {}
  }
  for (const res of playlistStateClients) {
    try { res.write(statePayload); } catch {}
  }
}

// NACHHER:
function broadcastPlaylists(userId) {
  const { PLAYLIST_STATE } = userContext;
  const activePayload = serializeActivePlaylist(PLAYLIST_STATE);
  const statePayload = serializePlaylistState(PLAYLIST_STATE);
  sseManager.broadcast(userId, "playlist-active", activePayload);
  sseManager.broadcast(userId, "playlist-state", statePayload);
}

// MUSTER: Alle Playlist-Endpunkte:
// - PLAYLIST_STATE → userContext.PLAYLIST_STATE
// - await savePlaylistsImmediate() → await userContext.savePlaylistsImmediate()
// - broadcastPlaylists() → broadcastPlaylists(req.auth.user.id)
// - SSE Endpoints über createSSEEndpoint()
*/

// ============================================================================
// PHASE 5: Sheets & Upload (Document Management)
// ============================================================================
/*
// /api/sheets (Zeile ~2628) - Filter nach User-Dokumenten:

app.get("/api/sheets", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const userId = req.auth.user.id;
  const { documents } = userContext.requireUserContext();
  
  // ... existing code ...
  const all = await getIndex();
  
  // NEU: Filter nach User-Zugriff
  let filtered = all.filter(item => documents.has(item.name));
  
  // ... rest wie vorher (onlyFav, q, categories, sort) ...
});

// /api/upload (Zeile ~2709) - Dokument registrieren:

app.post("/api/upload", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const userId = req.auth.user.id;
  
  // ... existing upload code ...
  
  // NEU: Nach erfolgreichem Upload Dokument registrieren
  try {
    dataStore.assignDocumentsToUser(userId, [rel], "owner");
    userContext.addDocumentsToUserCache(userId, [rel]);
  } catch (err) {
    console.error("Failed to register document:", err);
    // Rollback: Datei löschen
    await cleanupFile();
    return res.status(500).json({ error: "Failed to register document" });
  }
  
  // ... rest ...
});

// NEU: DELETE Endpoint hinzufügen (nach /api/upload):

app.delete("/api/sheets/:name", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const userId = req.auth.user.id;
  const name = decodeURIComponent(req.params.name);
  
  const info = resolvePdfName(name);
  if (!info) {
    return res.status(404).json({ error: "File not found" });
  }
  
  // Prüfe Ownership
  const ownedDocs = await dataStore.listOwnedDocumentRelPaths(userId);
  if (!ownedDocs.includes(info.rel)) {
    return res.status(403).json({ error: "Not authorized to delete this file" });
  }
  
  try {
    // Lösche Datei
    await fs.promises.unlink(info.abs);
    
    // Lösche Thumbnail
    const thumbPath = path.join(THUMBS_DIR, thumbnailRelPath(info.rel));
    await fs.promises.unlink(thumbPath).catch(() => {});
    
    // Lösche aus Index
    indexCache.items = indexCache.items.filter(item => item.name !== info.rel);
    
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete failed:", err);
    res.status(500).json({ error: "Failed to delete file" });
  }
});
*/

// ============================================================================
// PHASE 6: Annotations (Ownership prüfen)
// ============================================================================
/*
// Alle /api/annotations/* Endpunkte:

// Zu Beginn jedes Handlers:
if (!ensureAuthenticated(req, res)) return;
const userId = req.auth.user.id;
const { documents } = userContext.requireUserContext();

const name = (req.body.name || req.query.name || "").toString();
const info = resolvePdfName(name);
if (!info) {
  return res.status(400).json({ error: "Invalid file name" });
}

// NEU: Zugriffsprüfung
if (!documents.has(info.rel)) {
  return res.status(403).json({ error: "Access denied" });
}

// ... rest wie vorher ...
*/

// ============================================================================
// SHUTDOWN Handler anpassen
// ============================================================================
/*
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${sig} received – shutting down…`);

  if (sheetWatcher && typeof sheetWatcher.close === "function") {
    try { sheetWatcher.close(); } catch (err) {
      console.warn("Error closing sheet watcher:", err.message);
    }
  }

  // NEU: Flush User-Caches
  if (userContext) {
    await userContext.flushAllUserCaches();
  }
  
  // NEU: Close SSE connections
  if (sseManager) {
    sseManager.closeAll();
  }

  // ... rest ...
}
*/

module.exports = {
  /* Dieser Plan dient als Referenz für den schrittweisen Umbau */
};
