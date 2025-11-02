# Sprungmarkierungen (Dal Segno & Coda) - Feature Dokumentation

## Übersicht

Dieses Feature ermöglicht es Pianisten, Sprungmarkierungen in PDF-Noten zu setzen, um Wiederholungen während des Auto-Scrolls automatisch zu handhaben.

## Verwendung

### 1. Edit-Modus aktivieren

Im PDF-Viewer auf den **Bearbeiten-Button** (Stift-Icon) in der Kontrollleiste klicken.
- Button wird grün wenn Edit-Modus aktiv ist
- Status zeigt "Edit-Modus: Klicke auf Seiten zum Setzen von Markierungen"

### 2. Markierungen setzen

**Auf eine Stelle im PDF klicken** wo eine Markierung gesetzt werden soll:

#### Start-Markierung (Dal Segno 𝄋)
- **Typ**: Start
- **Tag**: Eindeutige Nummer/Name (z.B. "1", "A", "Refrain")
- **Wiederholungen**: Wie oft dieser Abschnitt wiederholt wird (Standard: 2)
- **Verwendung**: Markiert den Beginn eines Wiederholungsabschnitts

#### End-Markierung (Coda ⌒)
- **Typ**: Ende
- **Tag**: Muss mit einer Start-Markierung übereinstimmen
- **Verwendung**: Markiert das Ende eines Abschnitts - hier springt der Scroll zurück zum Start mit gleichem Tag

### 3. Beispiel-Workflow

Für ein Stück mit einer einfachen Wiederholung:

1. **Seite 2, Takt 10**: Start-Markierung setzen
   - Typ: Start
   - Tag: "1"
   - Wiederholungen: 2

2. **Seite 4, Takt 40**: End-Markierung setzen
   - Typ: Ende
   - Tag: "1"

**Ergebnis beim Auto-Scroll**:
- Seite 1 → Seite 2 → Seite 3 → Seite 4 (Ende 1 erreicht)
- → Springt zurück zu Seite 2 (Start 1)
- → Seite 2 → Seite 3 → Seite 4 (zweite Wiederholung abgeschlossen)
- → Seite 5 → ... → Ende

### 4. Markierungen bearbeiten/löschen

Im Edit-Modus auf eine existierende Markierung klicken:
- **Bearbeiten**: Tag, Typ oder Wiederholungen ändern
- **Löschen**: Markierung entfernen
- **Verschieben**: Markierung an eine neue Position ziehen

### 5. Markierungen werden automatisch gespeichert

Alle Änderungen werden sofort auf dem Server gespeichert und sind persistent.

## Technische Details

### Datenstruktur

```javascript
{
  "pageNumber": 2,      // Seitennummer
  "type": "start",      // "start" oder "end"
  "tag": "1",           // Eindeutiger Tag
  "repeatCount": 2,     // Nur bei type="start"
  "x": 50,              // Position in % (0-100)
  "y": 30               // Position in % (0-100)
}
```

### Server-Endpunkte

**GET `/api/prefs/file?name={filename}`**
- Lädt Markierungen für eine Datei

**POST `/api/prefs/file`**
```json
{
  "name": "mein-stueck.pdf",
  "jumpMarkers": [...]
}
```

### Auto-Scroll Algorithmus

1. **Sequenz-Berechnung**: Baut eine flache Liste von Seitenzahlen basierend auf den Markierungen
2. **Wiederholungs-Tracking**: Zählt Besuche pro Tag
3. **Sprung-Logik**: Bei End-Markierung zurück zur Start-Markierung springen, solange repeatCount nicht erreicht
4. **Kontinuierliches Scrolling**: Innerhalb jeder Seite normale Pixel-basierte Geschwindigkeit

## Visuelle Darstellung

### Start-Markierung (Grün)
```
┌─────────────────┐
│ 🎵 1 ×2         │ ← Grüner Badge
└─────────────────┘
```

### End-Markierung (Orange)
```
┌─────────────────┐
│ ⌒ 1             │ ← Oranger Badge
└─────────────────┘
```

## Mehrere Wiederholungen

Es können beliebig viele Markierungen gesetzt werden:

```
Seite 1-2:   Normal
Seite 3-5:   Start "A" ×3 ... Ende "A" (3× wiederholen)
Seite 6-8:   Start "B" ×2 ... Ende "B" (2× wiederholen)
Seite 9-10:  Normal
```

**Scroll-Sequenz**:
```
1 → 2 → 3 → 4 → 5 → (Sprung zu 3) → 3 → 4 → 5 → (Sprung zu 3) → 3 → 4 → 5 →
6 → 7 → 8 → (Sprung zu 6) → 6 → 7 → 8 → 9 → 10
```

## Tastaturkürzel

- **E**: Edit-Modus toggle (zukünftig)
- **Escape**: Verlässt Edit-Modus (zukünftig)

## Fehlerbehandlung

- **Ungültige Tags**: Werden ignoriert
- **Fehlende Paare**: Start ohne Ende wird normal durchscrollt
- **Endlosschleifen**: Maximal 10× Seitenanzahl Iterationen als Sicherheit

## Best Practices

1. **Eindeutige Tags verwenden**: z.B. 1, 2, 3 oder A, B, C
2. **Klare Positionierung**: Markierungen am Anfang/Ende der Takte setzen
3. **Vor dem Auftritt testen**: Edit-Modus deaktivieren und Auto-Scroll testen
4. **Wiederholungen begrenzen**: Maximal 99 Wiederholungen technisch möglich
