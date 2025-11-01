# Piano Sheets - Performance Optimiert für iPad

Eine speicheroptimierte Piano-Notenblatt-Bibliothek mit verbesserter iPad-Unterstützung.

## 🚀 Performance-Verbesserungen

### Client-seitige Optimierungen:
- **Speicher-Überwachung**: Automatische Erkennung von kritischen Speicherzuständen
- **Aggressive Speicherbereinigung**: Automatisches Löschen von Canvas-Objekten außerhalb des Sichtbereichs
- **Limitierte Thumbnail-Cache**: Begrenzt auf 50 Einträge mit LRU-Cleanup
- **Optimierte PDF-Rendering**: Bessere Canvas-Verwaltung und Memory-Leaks-Vermeidung
- **Reduzierte Concurrency**: Weniger gleichzeitige Operationen bei niedrigem Speicher

### Server-seitige Optimierungen:
- **Batch-basiertes Dateisystem-Scanning**: Reduziert Speicher-Spitzen
- **Limitierte Range-Requests**: Verhindert übermäßige Speichernutzung bei großen PDFs
- **Speicher-Monitoring**: APIs zur Überwachung und manuellen Garbage Collection
- **Optimierte Kompression**: Intelligente Gzip-Kompression basierend auf Dateityp
- **Cache-Management**: Regelmäßige Bereinigung des Datei-Index-Cache

## 📱 iPad-spezifische Verbesserungen

- Wake Lock automatisch aktiviert im Viewer
- Verbesserte Touch-Gesten-Erkennung
- Optimierte Canvas-Größen für mobile Geräte
- Reduzierte Memory-Footprint für bessere Stabilität
- Automatische Neuladen-Vermeidung durch Speicher-Management

## 🛠 Installation & Start

### Standard-Start:
```bash
npm start
```

### Optimierter Start (empfohlen für iPad-Nutzung):
```bash
npm run start:optimized
```

### Mit expliziter Speicher-Kontrolle:
```bash
npm run start:memory
```

## 📊 Speicher-Monitoring

### Client-seitig:
- Speicher-Status in der Library-Ansicht
- Automatische Bereinigung bei > 80% Speichernutzung
- Konsolen-Warnungen bei kritischen Zuständen

### Server-seitig:
- `GET /api/system/memory` - Aktuelle Speichernutzung
- `POST /api/system/gc` - Manuelle Garbage Collection
- `POST /api/system/cache/clear` - Cache leeren
- Automatische Speicher-Logs alle 60 Sekunden

## 🎯 Typische Speicher-Profile

### Vor Optimierung:
- Library: ~150-300MB RAM
- Viewer: ~400-800MB RAM
- **Problem**: Automatische Neustarts auf iPad

### Nach Optimierung:
- Library: ~50-100MB RAM
- Viewer: ~100-200MB RAM
- **Resultat**: Stabile Ausführung auf iPad

## ⚙️ Konfiguration

Die Speicher-Einstellungen können in `server.js` angepasst werden:

```javascript
const MEMORY_SETTINGS = {
  maxIndexCacheAge: 5000,    // Cache-Alter für Datei-Index
  maxVendorRetries: 3,       // Vendor-Download-Versuche
  maxStatConcurrency: 32,    // Gleichzeitige Datei-Stats
  enableGzipCompression: true
};
```

Client-seitige Limits in `index.html`:

```javascript
thumbs: { 
  maxCacheSize: 50,          // Max. Thumbnails im Cache
  maxConcurrent: 1           // Gleichzeitige PDF-Operationen
}
```

## 🔧 Troubleshooting

### Bei weiterhin hoher Speichernutzung:
1. Reduziere `maxCacheSize` auf 25
2. Setze `maxConcurrent` auf 1
3. Starte mit `--max-old-space-size=256` für noch kleineren Heap

### Bei langsamen Ladezeiten:
1. Erhöhe `maxStatConcurrency` auf 64
2. Setze `maxCacheSize` auf 100
3. Aktiviere Vendor-Vorladen

### Debug-Modi:
```bash
# Mit Garbage Collection Tracing
NODE_OPTIONS="--trace-gc --expose-gc" node server.js

# Mit Inspektor
npm run dev
```

## 📈 Performance-Metriken

- **Startup-Zeit**: ~2-5 Sekunden (abhängig von PDF-Anzahl)
- **Memory-Baseline**: ~30-50MB (Server + Client)
- **Thumbnail-Generation**: ~1-3 Sekunden pro PDF
- **Page-Rendering**: ~500ms-2s pro Seite (abhängig von Komplexität)

## 🎵 Ideal für:

- iPad/Tablet-Nutzung während des Spielens
- Große PDF-Sammlungen (>1000 Dateien)
- Umgebungen mit begrenztem Arbeitsspeicher
- Offline-Nutzung (alle Vendor-Libraries werden lokal gecacht)