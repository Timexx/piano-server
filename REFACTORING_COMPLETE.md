# Server Refactoring - Abschluss-Dokumentation

## ✅ Erfolgreich implementiert

### 1. Neue Module

#### `lib/user-context-middleware.js`
Zentrale Middleware für User-spezifische Daten:
- **Automatisches Laden**: Config, Playlists, Documents pro Request
- **Auto-Persist**: Speichert dirty data automatisch bei Response
- **Proxy-Objekte**: `CONFIG` und `PLAYLIST_STATE` funktionieren transparent
- **Cache**: Hält User-Daten im Memory für Performance
- **AsyncLocalStorage**: Thread-safe Context-Management

**API:**
```javascript
const userContext = createUserContextMiddleware({ dataStore, logger });

// In Routes:
const { CONFIG, PLAYLIST_STATE } = userContext;
userContext.markConfigDirty();
await userContext.persistConfigNow();
```

#### `lib/user-sse-manager.js`
SSE (Server-Sent Events) pro User und Kanal:
- **User-Isolation**: Jeder User erhält nur seine Updates
- **Multi-Channel**: Separate Streams für playlist-state, playlist-active, etc.
- **Auto-Cleanup**: Entfernt geschlossene Verbindungen automatisch
- **Keep-Alive**: Automatische Ping-Messages
- **Broadcasting**: Effizientes Senden an spezifische User oder alle

**API:**
```javascript
const sseManager = new UserSSEManager({ logger });

// Subscribe:
sseManager.subscribe(userId, channel, res);

// Broadcast:
sseManager.broadcast(userId, channel, data);

// Endpoint Helper:
app.get("/api/events", createSSEEndpoint({
  manager: sseManager,
  channel: "updates",
  requireAuth: true,
  initialData: (req) => ({ ... }),
}));
```

### 2. Architektur-Änderungen

#### Middleware-Kette
```
Request 
  → express.json()           // Body parsing
  → authMiddleware          // Session cookie → req.auth
  → userContext.middleware  // Load user data
  → Route Handler           // Business logic
  → Auto-Save              // Persist dirty data
  → Response
```

#### Datenfluss

**Vorher (Global State):**
```
Request → CONFIG (global) → Modify → Save
        → PLAYLIST_STATE (global) → Modify → Save
        → broadcast to ALL clients
```

**Nachher (Per-User State):**
```
Request 
  → req.auth.user.id
  → Load CONFIG (user-specific from cache/DB)
  → Load PLAYLIST_STATE (user-specific)
  → Modify through Proxy
  → Auto-save on response
  → Broadcast to USER's SSE connections only
```

### 3. Migration

#### Automatische Daten-Migration
`dataStore.ensureInitialMigration()` beim Server-Start:

1. **Prüft** ob Migration bereits gelaufen
2. **Liest** `data/config.json` und `data/playlists.json`
3. **Findet** Admin-User (oder ersten User)
4. **Speichert** Config und Playlists für Admin in DB
5. **Scannt** `sheets/` Directory für PDFs
6. **Registriert** alle PDFs als Admin-Dokumente
7. **Erstellt Backups** der JSON-Files (`.bak-[timestamp]`)
8. **Markiert** Migration als abgeschlossen

#### Server Code Migration
Migrations-Skript erstellt: `scripts/migrate-server.js`

**Führt automatisch aus:**
- Entfernt alte User-Context Proxy-Definitionen
- Entfernt alte SSE Client Sets
- Aktualisiert `broadcastPlaylists()` function
- Markiert deprecated functions
- Erstellt Backup (`server.js.backup`)

**Ausführen:**
```bash
node scripts/migrate-server.js
```

### 4. Server-Initialisierung

Der Server initialisiert jetzt in dieser Reihenfolge:

```javascript
// 1. Services
authService = await createAuthService({ dataDir, logger });
dataStore = await createDataStore({ authService, dataDir, sheetsDir, logger });

// 2. Migration
await dataStore.ensureInitialMigration();

// 3. User-Context & SSE
userContext = createUserContextMiddleware({ dataStore, logger });
sseManager = new UserSSEManager({ logger });

// 4. Middleware registrieren
app.use(userContext.middleware);
```

### 5. API-Änderungen

Alle API-Endpunkte wurden angepasst:

#### Config-Endpunkte (`/api/prefs/*`, `/api/categories/*`)
```javascript
// Vorher:
app.get("/api/prefs", async (req, res) => {
  await ensureConfigFresh();
  res.json(CONFIG);
});

// Nachher:
app.get("/api/prefs", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { CONFIG } = userContext;
  res.json(CONFIG);
});
```

#### Playlist-Endpunkte (`/api/playlists/*`)
```javascript
// Vorher:
const { PLAYLIST_STATE } = global;
await savePlaylistsImmediate();
broadcastPlaylists();

// Nachher:
const { PLAYLIST_STATE } = userContext;
await userContext.savePlaylistsImmediate();
broadcastPlaylists(); // jetzt user-specific
```

#### SSE-Endpunkte
```javascript
// Vorher:
playlistStateClients.add(res);

// Nachher:
sseManager.subscribe(userId, "playlist-state", res);
```

#### Sheets-Endpunkt (`/api/sheets`)
```javascript
// NEU: Document-Filtering
const { documents } = userContext.requireUserContext();
let filtered = all.filter(item => documents.has(item.name));
```

#### Upload-Endpunkt (`/api/upload`)
```javascript
// NEU: Document-Registration
await dataStore.assignDocumentsToUser(userId, [rel], "owner");
userContext.addDocumentsToUserCache(userId, [rel]);
```

### 6. Shutdown-Handler

Erweitert um User-Cache-Flush und SSE-Cleanup:

```javascript
async function shutdown(sig) {
  // ... existing code ...
  
  // NEU: Flush user caches
  if (userContext) {
    await userContext.flushAllUserCaches();
  }
  
  // NEU: Close SSE connections
  if (sseManager) {
    sseManager.closeAll();
  }
  
  // ... existing code ...
}
```

## 📊 Vorteile

### Multi-User Support
- ✅ Jeder User hat eigene Config (favorites, categories, file settings)
- ✅ Jeder User hat eigene Playlists
- ✅ Jeder User sieht nur seine PDFs (oder geteilte)
- ✅ Admin kann User verwalten

### Skalierbarkeit
- ✅ User-Daten werden gecached (Memory-effizient)
- ✅ Nur dirty data wird gespeichert (I/O-effizient)
- ✅ SSE pro User (Network-effizient)
- ✅ AsyncLocalStorage (Thread-safe)

### Wartbarkeit
- ✅ Klare Separation of Concerns
- ✅ Testbare Module
- ✅ Dokumentierter Code
- ✅ Migrations-Pfad definiert

### Sicherheit
- ✅ Authentifizierung für alle sensitiven Endpoints
- ✅ Access-Control für Dokumente
- ✅ Session-Management
- ✅ User-Isolation

## 🚀 Deployment

### Voraussetzungen
- Node.js 16+
- Existierende `data/config.json` und `data/playlists.json` (optional)
- SQLite-kompatible Umgebung

### Schritt-für-Schritt

1. **Code aktualisieren:**
   ```bash
   git pull
   npm install
   ```

2. **Server-Migration ausführen:**
   ```bash
   node scripts/migrate-server.js
   ```

3. **Umgebungsvariablen setzen (optional):**
   ```bash
   export ADMIN_EMAIL=admin@example.com
   export ADMIN_PASSWORD=SecurePassword123!
   export AUTH_ENCRYPTION_KEY=<base64-key>
   ```

4. **Server starten:**
   ```bash
   node server.js
   ```

5. **Automatische Migration:**
   - Server liest `data/config.json` und `data/playlists.json`
   - Migriert Daten in `data/auth.sqlite`
   - Erstellt Backups der JSON-Files
   - Logged Initial-Admin-Credentials (wenn default)

6. **Verifizierung:**
   - Login mit Admin-Credentials
   - Prüfe ob PDFs sichtbar sind
   - Prüfe ob Playlists geladen wurden
   - Erstelle Test-User
   - Prüfe User-Isolation

### Rollback

Falls Probleme auftreten:

```bash
# 1. Server stoppen
pkill -f "node server.js"

# 2. Code zurücksetzen
cp server.js.backup server.js

# 3. JSON-Files wiederherstellen (falls nötig)
# Backup-Files: data/config.json.bak-[timestamp]

# 4. Datenbank behalten (Migration ist idempotent)
# Oder löschen: rm data/auth.sqlite*

# 5. Server neu starten
node server.js
```

## 🧪 Testing

### Manuelle Tests

1. **Login/Logout:**
   - Login als Admin
   - Session sollte persistieren
   - Logout sollte Session löschen

2. **Multi-User:**
   - Erstelle zweiten User
   - Upload PDF als User 1
   - User 2 sollte PDF nicht sehen
   - Admin sollte alle PDFs sehen

3. **Playlists:**
   - Erstelle Playlist als User 1
   - User 2 sollte sie nicht sehen
   - SSE Updates sollten nur an User 1 gehen

4. **Config:**
   - Setze Favoriten als User 1
   - User 2 sollte andere Favoriten haben können
   - Categories sollten per-user sein

5. **SSE:**
   - Öffne Browser DevTools → Network → EventStream
   - Ändere Playlist
   - Update sollte sofort sichtbar sein
   - Andere User sollten kein Update erhalten

### Automatisierte Tests

```bash
# Unit Tests (noch zu implementieren)
npm test

# Integration Tests
npm run test:integration

# E2E Tests
npm run test:e2e
```

## 📝 Dokumentation

- ✅ `IMPLEMENTATION_GUIDE.md` - Schritt-für-Schritt Anleitung
- ✅ `REFACTORING_STATUS.md` - Status-Übersicht
- ✅ `server-migration-plan.js` - Code-Level Migration Plan
- ✅ `scripts/migrate-server.js` - Automatisches Migrations-Skript
- ✅ Inline-Code-Kommentare in allen neuen Modulen

## 🐛 Bekannte Einschränkungen

1. **Document Sharing**: Noch nicht implementiert
   - User können noch keine PDFs mit anderen teilen
   - Admin sieht alle PDFs, aber kein Sharing-UI

2. **Annotations**: Noch keine Ownership-Prüfung
   - Annotations werden noch nicht per-user gespeichert
   - Alle User können aktuell alle Annotations sehen/ändern

3. **Migration**: Nur für Single-Admin-Setup
   - Multi-Admin-Setup braucht manuelle Anpassung
   - Geteilte PDFs zwischen Usern nicht migriert

## 🔮 Nächste Schritte

1. **Document Sharing UI** implementieren
2. **Annotations** pro User oder geteilt
3. **Admin Dashboard** für User-Management
4. **Quota Management** (PDF count, storage bytes)
5. **Audit Log** für Admin-Aktionen
6. **API Tests** schreiben
7. **Performance Monitoring** einbauen

## 📞 Support

Bei Fragen oder Problemen:
1. Prüfe Logs: `tail -f server.log`
2. Prüfe Database: `sqlite3 data/auth.sqlite`
3. Erstelle GitHub Issue mit Logs

---

**Status**: ✅ Implementierung abgeschlossen und dokumentiert
**Version**: 2.0.0-refactored  
**Datum**: 4. November 2025
