# Migration zu User-spezifischem Storage

## Problem
Nach der Umstellung auf user-spezifische Daten sind die alten Daten (config.json, playlists.json) noch nicht einem User zugeordnet.

## Lösung: Migration-Script ausführen

### Schritt 1: Server stoppen (falls läuft)
```bash
# Ctrl+C im Terminal wo der Server läuft
```

### Schritt 2: Migration-Script ausführen

**Option A: Mit spezifischem User (wenn du die Email kennst)**
```bash
node scripts/migrate-to-user.js your-email@example.com
```

**Option B: Interaktiv (Script fragt nach User)**
```bash
node scripts/migrate-to-user.js
```

Das Script wird:
1. Alle existierenden User auflisten
2. Dich nach dem Ziel-User fragen (oder neuen Admin erstellen)
3. Die Backups von config.json und playlists.json wiederherstellen
4. Alle Daten dem gewählten User zuordnen
5. Alle PDF-Dateien im `sheets/` Ordner registrieren und dem User zuweisen

### Schritt 3: Server neu starten
```bash
npm start
```

### Schritt 4: Einloggen
Gehe zu `http://localhost:3000` → Du wirst zur Login-Seite redirected → Logge dich mit dem User ein, dem du die Daten zugewiesen hast.

## Was das Script macht

1. **Rollback**: Stellt config.json und playlists.json aus den Backups wieder her
2. **Import**: Importiert die Daten in die SQLite-Datenbank für den gewählten User
3. **Document Registration**: Scannt alle PDFs im `sheets/` Ordner und registriert sie
4. **User Assignment**: Weist alle gefundenen Dokumente dem gewählten User zu
5. **Backup**: Erstellt neue Backups mit Timestamp

## Nach der Migration

- ✅ Ohne Login: Redirect zur Login-Seite
- ✅ Mit Login: Alle deine Daten sind sichtbar (Kategorien, Favorites, Playlists, PDFs)
- ✅ Multi-User: Jeder User hat seine eigenen Daten
- ✅ SSE-Updates: Nur der eigene User bekommt Live-Updates

## Troubleshooting

**"No users found in database"**
→ Script bietet an, einen neuen Admin-User zu erstellen

**"Database not found"**
→ Server muss mindestens einmal gestartet worden sein, um die DB zu erstellen

**"No backup files found"**
→ Keine alten Daten vorhanden, nichts zu migrieren
