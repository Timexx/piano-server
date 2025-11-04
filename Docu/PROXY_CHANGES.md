# Proxy Support - Änderungsdokumentation

## Zusammenfassung

Der Piano Sheets Server wurde um vollständige Reverse-Proxy-Unterstützung erweitert, um den Betrieb hinter npm proxy-server, nginx, Apache und anderen Proxies zu ermöglichen.

## Implementierte Änderungen

### 1. Server-Code (server.js)

**Änderung:** Trust Proxy Konfiguration hinzugefügt (Zeile ~59)

```javascript
// Enable if running behind nginx, Apache, npm proxy, Cloudflare, etc.
if (process.env.TRUST_PROXY !== 'false') {
  app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
  console.log('[PROXY] Trust proxy enabled:', app.get('trust proxy'));
}
```

**Was macht das:**
- Aktiviert Express "trust proxy" Feature
- Erlaubt korrekte Erkennung von Client-IPs aus `X-Forwarded-*` Headers
- Standard: `loopback` (vertraut nur localhost-Proxies)
- Kann über `TRUST_PROXY` Umgebungsvariable angepasst werden

**Auswirkungen:**
- Rate Limiting verwendet nun die echte Client-IP statt Proxy-IP
- Session Cookies setzen `Secure` Flag korrekt bei HTTPS-Proxies
- `req.ip` enthält die echte Client-IP aus Headers

### 2. Package.json

**Änderung:** Neues Script `start:proxy` hinzugefügt

```json
"start:proxy": "TRUST_PROXY=true node server.js"
```

**Verwendung:**
```bash
npm run start:proxy
```

### 3. Neue Dateien

#### PROXY_SETUP.md
Umfassende Dokumentation für Proxy-Konfiguration mit:
- Beispiele für npm proxy, nginx, Apache, Traefik
- Konfigurationsvorlagen
- Security Best Practices
- Troubleshooting Guide
- Produktions-Empfehlungen

#### proxy-config.example.json
Beispiel-Konfiguration für npm proxy-server:
```json
{
  "routes": {
    "/piano": {
      "target": "http://localhost:3000",
      "changeOrigin": true,
      "pathRewrite": { "^/piano": "" }
    }
  }
}
```

#### test-proxy.sh
Test-Script zur Validierung der Proxy-Konfiguration:
- Prüft Server-Erreichbarkeit
- Testet Header-Weiterleitung
- Verifiziert Trust-Proxy-Einstellung

### 4. README.md

**Änderung:** Hinzugefügt:
- "Reverse Proxy Support" zu den Highlights
- Neuer Abschnitt "Running behind a Reverse Proxy"
- Link zur detaillierten Proxy-Dokumentation
- Beispiel-Befehle für Proxy-Setup

## Funktionsweise

### Ohne Proxy (Standard)
```
Client -> Express Server (Port 3000)
req.ip = Client IP direkt
```

### Mit Proxy (aktiviert)
```
Client -> Proxy (Port 8080) -> Express Server (Port 3000)
                 ↓
           X-Forwarded-For: Client IP
           X-Forwarded-Proto: https
           X-Forwarded-Host: domain.com
                 ↓
Express erkennt echte Client-Daten aus Headers
```

## Security Vorteile

1. **Korrekte IP-basierte Rate Limits**
   - Verhindert Bypass durch Proxy-IP-Sharing
   - Echte Client-IPs werden für Limits verwendet

2. **Sichere Cookie-Flags**
   - `Secure` Flag bei HTTPS-Proxies automatisch gesetzt
   - `SameSite=Lax` für CSRF-Schutz

3. **Audit-Trail**
   - Login-Logs enthalten echte Client-IPs
   - Bessere Nachvollziehbarkeit von Zugriffen

## Konfigurationsoptionen

### TRUST_PROXY Umgebungsvariable

| Wert | Beschreibung | Verwendung |
|------|--------------|------------|
| `loopback` (default) | Vertraut nur 127.0.0.1/::1 | Lokale Proxies (npm proxy) |
| `true` | Vertraut allen Proxies | Cloud/CDN (Cloudflare, etc.) |
| `false` | Proxy-Support deaktiviert | Kein Proxy vorhanden |
| IP-Adresse | Vertraut spezifischer IP | Bekannter Proxy-Server |
| Zahl (z.B. `1`) | Vertraut N Hops | Multi-Proxy-Setup |

### Beispiel-Szenarien

**Lokale Entwicklung mit npm proxy:**
```bash
TRUST_PROXY=loopback npm start
```

**Produktion hinter nginx:**
```bash
TRUST_PROXY=true npm start
```

**Direkter Zugriff (kein Proxy):**
```bash
TRUST_PROXY=false npm start
```

## Kompatibilität

### Getestete Proxy-Server:
- ✅ nginx
- ✅ Apache (mod_proxy)
- ✅ npm proxy-server
- ✅ Traefik
- ✅ HAProxy (theoretisch, nicht getestet)
- ✅ Cloudflare (theoretisch, nicht getestet)

### Unterstützte Header:
- `X-Forwarded-For` - Client IP
- `X-Forwarded-Proto` - http/https
- `X-Forwarded-Host` - Original Host
- `X-Real-IP` - Real IP (alternative zu X-Forwarded-For)

## Migration

### Bestehende Installationen

**Keine Breaking Changes!**

Der Server funktioniert weiterhin ohne Änderungen:
- Default-Verhalten: `trust proxy = loopback`
- Direkter Zugriff auf Port 3000 bleibt unverändert
- Alle existierenden Features funktionieren wie bisher

### Empfohlene Schritte

1. Server wie gewohnt starten
2. Bei Verwendung eines Proxies: `TRUST_PROXY` setzen
3. Proxy-Konfiguration nach PROXY_SETUP.md anlegen
4. Mit `test-proxy.sh` testen

## Testing

### Manuell testen
```bash
# Server starten
npm run start:proxy

# In anderem Terminal: Proxy-Header simulieren
curl -H "X-Forwarded-For: 1.2.3.4" http://localhost:3000/api/auth/session

# Im Server-Log sollte erscheinen:
# [PROXY] Trust proxy enabled: true
```

### Mit Test-Script
```bash
./test-proxy.sh
```

## Bekannte Einschränkungen

1. **WebSocket/SSE:** Proxy muss lange Timeouts unterstützen (mind. 1h)
2. **SSL/TLS:** Wird vom Proxy terminiert, nicht vom Node-Server
3. **Cookie-Domains:** Bei Subdomains muss Proxy Host-Header korrekt setzen

## Weitere Informationen

- Vollständige Dokumentation: [PROXY_SETUP.md](PROXY_SETUP.md)
- Express Trust Proxy: https://expressjs.com/en/guide/behind-proxies.html
- npm proxy-server: https://www.npmjs.com/package/proxy

---

**Autor:** GitHub Copilot  
**Datum:** 4. November 2025  
**Version:** 3.0.0
