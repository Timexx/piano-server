# Server Refactoring - Implementierungsanleitung

## Problem
Der bestehende `server.js` ist 3500+ Zeilen lang und hat mehrere redundante Definitionen. Ein komplettes Rewrite würde zu lange dauern und ist fehleranfällig.

## Lösung: Minimaler Umbau mit maximaler Wirkung

### Schritt 1: Neue Module sind fertig ✅
- `lib/user-context-middleware.js` - User-Context Management
- `lib/user-sse-manager.js` - Per-User SSE Streams

### Schritt 2: Server.js Anpassungen (Minimal Invasive)

#### 2.1 Imports hinzufügen (nach Zeile 13)
```javascript
const { createUserContextMiddleware } = require("./lib/user-context-middleware");
const { UserSSEManager, createSSEEndpoint } = require("./lib/user-sse-manager");
```

#### 2.2 Globale Variablen ersetzen (Zeilen 1189-1328)

**ENTFERNEN:**
```javascript
// Zeilen 1189-1258: Alten Code für CONFIG und PLAYLIST_STATE Proxies
// Zeilen 1263-1281: const PLAYLIST_STATE = new Proxy...
// Zeilen 1282-1283: const playlistActiveClients/playlistStateClients Maps
```

**BEHALTEN:**
```javascript
// Zeilen 1285-1328: Playlist utility functions (createPlaylistId, pickAccentColor, etc.)
```

#### 2.3 Playlist State laden - ÄNDERN (Zeilen 1420-1450)

**VORHER:**
```javascript
let PLAYLIST_STATE = loadPlaylists();
let _playlistSaveInProgress = null;
```

**NACHHER:**
```javascript
// Legacy Playlist Loading (wird von DataStore Migration übernommen)
// Diese Funktionen bleiben für Fallback, werden aber nicht mehr direkt genutzt
```

#### 2.4 SSE Clients - ÄNDERN (Zeilen 1526-1527)

**VORHER:**
```javascript
const playlistActiveClients = new Set();
const playlistStateClients = new Set();
```

**NACHHER:**
```javascript
// Entfernt - wird durch sseManager ersetzt
```

#### 2.5 Initialisierung - ERWEITERN (Zeile 3463)

**Bereits erledigt** ✅

### Schritt 3: API Endpoints anpassen

#### 3.1 Playlist SSE Endpoints (Zeilen ~1630, ~1652)

**VORHER:**
```javascript
app.get("/api/playlists/events", (req, res) => {
  // ... manual SSE setup ...
  playlistStateClients.add(res);
  // ...
});
```

**NACHHER:**
```javascript
app.get("/api/playlists/events", (req, res) => {
  if (!req.auth || !req.auth.user) {
    return res.status(401).json({ error: "AUTH_REQUIRED" });
  }
  
  const userId = req.auth.user.id;
  const { PLAYLIST_STATE } = userContext;
  
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  if (res.flushHeaders) res.flushHeaders();

  // Send initial data
  try {
    res.write(`data: ${JSON.stringify(serializePlaylistState(PLAYLIST_STATE))}\n\n`);
  } catch {}

  // Register with SSE manager
  sseManager.subscribe(userId, "playlist-state", res);

  // Keep-alive
  const keepAlive = setInterval(() => {
    sseManager.ping(userId, "playlist-state");
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    try { res.end(); } catch {}
  });
});
```

Gleich für `/api/playlist/events`.

#### 3.2 Broadcast Function - ÄNDERN (Zeile ~1545)

**VORHER:**
```javascript
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
```

**NACHHER:**
```javascript
function broadcastPlaylists() {
  // Broadcast to current user only
  const store = userContext.getRequestContext();
  if (!store || !store.userId) return;
  
  const { PLAYLIST_STATE } = userContext;
  const activePayload = serializeActivePlaylist();
  const statePayload = serializePlaylistState(PLAYLIST_STATE);
  
  sseManager.broadcast(store.userId, "playlist-active", activePayload);
  sseManager.broadcast(store.userId, "playlist-state", statePayload);
}
```

#### 3.3 Config Endpoints - Authentifizierung hinzufügen

Alle `/api/prefs/*` und `/api/categories/*` Endpoints:

**ANFANG JEDES HANDLERS:**
```javascript
if (!ensureAuthenticated(req, res)) return;
```

**CONFIG Zugriff:**
```javascript
const { CONFIG } = userContext;
```

**Persist:**
```javascript
await userContext.persistConfigNow();
```

#### 3.4 Sheets API - Document Filtering (Zeile ~2628)

**NACH:**
```javascript
app.get("/api/sheets", async (req, res) => {
```

**HINZUFÜGEN:**
```javascript
  if (!ensureAuthenticated(req, res)) return;
  const store = userContext.requireUserContext();
  const { documents } = store;
```

**FILTER ANPASSEN:**
```javascript
  const all = await getIndex();
  let filtered = all.filter(item => documents.has(item.name)); // NEU: Filter nach Zugriff
  
  if (onlyFav) {
    const { CONFIG } = userContext;
    const favSet = new Set(CONFIG.favorites);
    filtered = filtered.filter(x => favSet.has(x.name));
  }
  // ... rest wie vorher
```

#### 3.5 Upload - Document Registration (Zeile ~2709)

**NACH erfolgreichem Upload (vor res.status(201).json):**
```javascript
  // Register document ownership
  try {
    await dataStore.assignDocumentsToUser(req.auth.user.id, [rel], "owner");
    userContext.addDocumentsToUserCache(req.auth.user.id, [rel]);
  } catch (err) {
    console.error("Failed to register document:", err);
    // Continue - file is uploaded, just not registered
  }
```

#### 3.6 Shutdown Handler - ERWEITERN (Zeile ~3485)

**NACH:**
```javascript
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${sig} received – shutting down…`);

  if (sheetWatcher && typeof sheetWatcher.close === "function") {
    try { sheetWatcher.close(); } catch (err) {
      console.warn("Error closing sheet watcher:", err.message);
    }
  }
```

**HINZUFÜGEN:**
```javascript
  // Flush user caches
  if (userContext) {
    try {
      await userContext.flushAllUserCaches();
      console.log("User caches flushed");
    } catch (err) {
      console.error("Failed to flush user caches:", err);
    }
  }

  // Close SSE connections
  if (sseManager) {
    try {
      const closed = sseManager.closeAll();
      console.log(`Closed ${closed} SSE connections`);
    } catch (err) {
      console.error("Failed to close SSE connections:", err);
    }
  }
```

**ENTFERNEN:**
```javascript
  await flushConfigBeforeExit();  // Nicht mehr nötig, wird durch userContext.flushAllUserCaches() ersetzt
```

### Schritt 4: Alte Funktionen entfernen/anpassen

**ENTFERNEN (oder zu Kommentar machen):**
- `ensureUserConfig()` (Zeile ~1180)
- `ensureUserPlaylists()` (Zeile ~1211)
- `ensureUserDocuments()` (Zeile ~1242)
- `flushConfigBeforeExit()` (Zeile ~1328)
- `savePlaylistsImmediate()` (erste Definition, Zeile ~1445)

**ANPASSEN:**
- `requireUserContext()` → `userContext.requireUserContext()`
- `getRequestContext()` → `userContext.getRequestContext()`
- `markConfigDirty()` → `userContext.markConfigDirty()`
- `markPlaylistsDirty()` → `userContext.markPlaylistsDirty()`

## Testing Plan

1. ✅ Start server
2. ✅ Login as admin
3. ✅ List sheets (should show all after migration)
4. ✅ Upload new PDF
5. ✅ Create playlist
6. ✅ Add to favorites
7. ✅ Create category
8. ✅ SSE: Watch playlist updates in browser devtools
9. ✅ Logout/Login - data should persist
10. ✅ Create second user - data should be isolated

## Rollback Plan

Wenn Probleme auftreten:
1. Stoppe Server
2. Restore `server.js` from git
3. Backup files: `data/config.json.bak-*`, `data/playlists.json.bak-*`
4. Database bleibt intakt - Migration ist idempotent

## Migration wird automatisch durchgeführt

Beim ersten Start mit den neuen Libraries:
1. `dataStore.ensureInitialMigration()` läuft
2. Liest `config.json` und `playlists.json`
3. Migriert Daten in SQLite
4. Erstellt Backups der JSON-Files
5. Assigned alle PDFs dem Admin-User

## Performance

- **Memory**: +~10-20MB für User-Caches (pro aktivem User)
- **I/O**: Weniger, da nur bei dirty flag gespeichert wird
- **Latency**: Keine Änderung (Caching kompensiert DB-Zugriffe)
- **SSE**: Effiziente per-User Broadcasts

## Nächste Schritte

1. Führe obige Änderungen in `server.js` durch
2. Teste mit existierendem Client
3. Wenn stabil: Lösche `server-refactored.js` und andere temp files
4. Update README mit neuer Architektur

