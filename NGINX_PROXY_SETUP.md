# Nginx Proxy Manager Setup für Piano Server unter `/music`

## Problem
Der Piano Server läuft unter einem Sub-Path (`/music`) im Nginx Proxy Manager, aber alle Ressourcen werden mit absoluten Pfaden geladen (`/csrf-protection.js` → `https://cloud.familieklement.com/csrf-protection.js` statt `/music/csrf-protection.js`).

## Lösung
Die App wurde so angepasst, dass sie mit einem konfigurierbaren Base Path funktioniert.

---

## 1. Server-Konfiguration

### Umgebungsvariable setzen
Erstelle eine `.env` Datei oder setze die Environment Variable:

```bash
# In /home/tim/piano/.env
BASE_PATH=/music
TRUST_PROXY=true
```

ODER starte den Server mit:

```bash
BASE_PATH=/music TRUST_PROXY=true npm start
```

### Mit PM2 (empfohlen)
```bash
# ecosystem.config.js erstellen
module.exports = {
  apps: [{
    name: 'piano-server',
    script: 'server.js',
    cwd: '/home/tim/piano',
    env: {
      NODE_ENV: 'production',
      BASE_PATH: '/music',
      TRUST_PROXY: 'true',
      PORT: 3000
    }
  }]
};

# PM2 starten
pm2 start ecosystem.config.js
pm2 save
```

---

## 2. Nginx Proxy Manager Konfiguration

### Custom Location: `/music`

**Scheme:** `http`  
**Forward Hostname / IP:** `localhost` (oder IP des Piano Servers)  
**Forward Port:** `3000`  
**Forward Path:** (leer lassen!)

### SSL-Einstellungen
- ✅ Force SSL
- ✅ HTTP/2 Support
- ✅ HSTS Enabled
- ✅ Certificate: Let's Encrypt

### Advanced Tab (Custom Nginx Configuration)
```nginx
# Proxy Headers für BASE_PATH Detection
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Real-IP $remote_addr;

# WebSocket Support (für SSE)
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";

# Timeouts für lange PDF-Uploads
proxy_read_timeout 300;
proxy_connect_timeout 300;
proxy_send_timeout 300;

# Buffer Settings
proxy_buffering off;
proxy_request_buffering off;
```

---

## 3. Wie es funktioniert

### Server-Side
1. `BASE_PATH` wird aus Environment Variable gelesen
2. Server injiziert `window.__BASE_PATH__` in alle HTML-Dateien
3. Alle API-Routen bleiben unverändert (Express handled das automatisch)

### Client-Side
1. `base-path.js` wird **zuerst** geladen (vor allen anderen Scripts)
2. Überschreibt `window.fetch()` um automatisch `/music` zu präfixen
3. Alle relativen Pfade werden automatisch angepasst

### Beispiel
```javascript
// Client-Code (unverändert):
fetch('/api/auth/login', {...})

// Wird automatisch zu:
fetch('/music/api/auth/login', {...})
```

---

## 4. Testing

### Lokaler Test (ohne Proxy)
```bash
# Start ohne BASE_PATH (Root-Path)
npm start

# Öffne: http://localhost:3000
# Alles sollte normal funktionieren
```

### Test mit BASE_PATH (simuliert Proxy)
```bash
# Start mit BASE_PATH
BASE_PATH=/music npm start

# Öffne: http://localhost:3000/music
# Alles sollte unter /music funktionieren
```

### Test durch Nginx Proxy
```bash
# 1. Nginx Proxy Manager Custom Location konfigurieren
# 2. Server mit BASE_PATH=/music starten
# 3. Öffne: https://cloud.familieklement.com/music
```

---

## 5. Verifikation

### Browser Console (erwartete Logs)
```
[BASE_PATH] Application running under: /music
[CSRF] Token retrieved successfully
```

### Network Tab (erwartete Requests)
```
✅ https://cloud.familieklement.com/music/base-path.js
✅ https://cloud.familieklement.com/music/csrf-protection.js
✅ https://cloud.familieklement.com/music/api/auth/session
✅ https://cloud.familieklement.com/music/vendor/pdfjs/pdf.min.js
```

### NICHT:
```
❌ https://cloud.familieklement.com/base-path.js (ohne /music)
❌ https://cloud.familieklement.com/api/auth/session (ohne /music)
```

---

## 6. Troubleshooting

### Problem: 404 Errors für Scripts
**Lösung:** Überprüfe, dass `BASE_PATH=/music` gesetzt ist und Server neugestartet wurde.

```bash
# Verify Environment Variable
pm2 env 0 | grep BASE_PATH

# Restart Server
pm2 restart piano-server
```

### Problem: CSP blockiert Tailwind CDN
**Lösung:** Bereits behoben! Tailwind CDN ist jetzt in der CSP erlaubt.

### Problem: Login funktioniert nicht
**Lösung:** CSRF-Token wird automatisch mit Base Path geholt. Check Browser Console für Fehler.

### Problem: PDFs laden nicht
**Lösung:** 
1. Check dass `TRUST_PROXY=true` gesetzt ist
2. Verify Nginx `proxy_set_header` Konfiguration
3. Check Server Logs: `pm2 logs piano-server`

---

## 7. Production Deployment Checklist

- [ ] `.env` Datei mit `BASE_PATH=/music` erstellt
- [ ] `TRUST_PROXY=true` gesetzt
- [ ] PM2 ecosystem.config.js konfiguriert
- [ ] Nginx Proxy Manager Custom Location `/music` erstellt
- [ ] SSL Certificate (Let's Encrypt) aktiviert
- [ ] Advanced Nginx Config mit Proxy Headers hinzugefügt
- [ ] Server neugestartet: `pm2 restart piano-server`
- [ ] Browser Test: `https://cloud.familieklement.com/music`
- [ ] Login Test durchgeführt
- [ ] PDF Upload Test durchgeführt
- [ ] CSRF Token funktioniert

---

## 8. Alternative: Root-Path mit Subdomain

Falls du den Server lieber unter Root (`/`) statt `/music` laufen lassen möchtest:

### Option A: Subdomain
```
https://piano.familieklement.com/ → http://localhost:3000/
```

**Nginx Proxy Manager:**
- **Domain Names:** `piano.familieklement.com`
- **Forward Hostname:** `localhost`
- **Forward Port:** `3000`
- **BASE_PATH:** (nicht setzen, leer lassen)

### Option B: Dedicated Port
```
https://cloud.familieklement.com:3001/ → http://localhost:3000/
```

---

## Fazit

✅ Server ist jetzt **Proxy-Ready**  
✅ Funktioniert sowohl unter Root (`/`) als auch Sub-Path (`/music`)  
✅ Automatische Pfad-Anpassung (transparent für API-Calls)  
✅ CSRF-Protection bleibt aktiv  
✅ Tailwind CDN ist CSP-erlaubt

**Start Command:**
```bash
BASE_PATH=/music TRUST_PROXY=true npm start
```
