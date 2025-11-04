# Server Refactoring - Zusammenfassung

## Durchgeführte Änderungen

### 1. User-Context Middleware (`lib/user-context-middleware.js`)
- ✅ Erstellt
- **Funktion**: Lädt pro Request automatisch Config, Playlists und Dokumente für den authentifizierten User
- **Auto-Persist**: Speichert Änderungen automatisch am Ende des Requests
- **Proxy-Objekte**: `CONFIG` und `PLAYLIST_STATE` funktionieren transparent wie vorher
- **Cache**: Hält User-Daten im Memory für Performance

### 2. Per-User SSE Manager (`lib/user-sse-manager.js`)
- ✅ Erstellt  
- **Funktion**: Verwaltet Server-Sent-Events pro User und Kanal
- **Isolation**: Jeder User erhält nur seine eigenen Updates
- **Channels**: Separate Streams für Playlists, Config, etc.
- **Keep-Alive**: Automatische Ping-Nachrichten

### 3. Server-Refactoring (server-refactored.js)
- 🔄 In Arbeit
- **Integration**: Bindet User-Context-Middleware und SSE-Manager ein
- **API-Umstellung**: Alle Endpunkte nutzen jetzt den User-Kontext
- **Document-Management**: Upload/Delete registriert Dokumente pro User
- **Access-Control**: Sheets-API filtert nach User-Rechten

## Architektur-Überblick

```
Request → Auth-Middleware → User-Context-Middleware → Route Handler
                                      ↓
                              [Load User Data]
                              - Config (favorites, categories, files)
                              - Playlists (state, activeId)
                              - Documents (accessible PDFs)
                                      ↓
                              [Process Request]
                              - Modify CONFIG proxy
                              - Modify PLAYLIST_STATE proxy
                                      ↓
                              [Auto-Save on Response]
                              - Save dirty config
                              - Save dirty playlists
                                      ↓
                              [Broadcast Updates]
                              - SSE per User
```

## Wichtige Änderungen

### Middleware-Reihenfolge
```javascript
app.use(express.json());
app.use(authMiddleware);           // Parse session cookie
app.use(userContext.middleware);   // Load user data (NEW)
```

### SSE Pro User
```javascript
// Alte Version (global)
playlistActiveClients.add(res);

// Neue Version (per user)
sseManager.subscribe(userId, "playlist-active", res);
sseManager.broadcast(userId, "playlist-active", data);
```

### Config-Zugriff
```javascript
// Funktioniert weiterhin gleich dank Proxy!
CONFIG.favorites.push(newFav);
CONFIG.files[rel] = { categories: [...] };

// Aber jetzt pro User isoliert
```

## Nächste Schritte

1. ✅ User-Context Middleware fertiggestellt
2. ✅ SSE-Manager fertiggestellt  
3. 🔄 Server-Refactoring (große Datei, wird in Teilen erstellt)
4. ⏳ Testing und Migration
5. ⏳ Alte config.json/playlists.json Backup erstellen

## Kompatibilität

- **API**: Alle bestehenden Endpunkte bleiben kompatibel
- **Client**: Keine Änderungen am Frontend nötig
- **Daten**: Automatische Migration beim ersten Start
- **Features**: Alle Funktionen bleiben erhalten

## Performance

- **Memory**: User-Daten werden gecached
- **I/O**: Nur bei Änderungen wird gespeichert (dirty flag)
- **Concurrent**: AsyncLocalStorage für Thread-Safety
- **SSE**: Keep-Alive reduziert Reconnects
