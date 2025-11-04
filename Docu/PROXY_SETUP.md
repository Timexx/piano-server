# Proxy Setup Guide

Dieser Guide erklärt, wie Sie den Piano Sheets Server hinter einem Reverse Proxy betreiben können.

## Übersicht

Der Server unterstützt jetzt den Betrieb hinter Reverse Proxies wie:
- **npm proxy-server**
- nginx
- Apache
- Cloudflare
- Traefik
- HAProxy

## Konfiguration

### 1. Server-Konfiguration

Der Server vertraut standardmäßig localhost-Proxies. Sie können dies über Umgebungsvariablen anpassen:

```bash
# Standard (vertraut localhost/loopback)
npm start

# Alle Proxies vertrauen (für Cloud-Setups)
TRUST_PROXY=true npm start

# Spezifische IP-Adresse vertrauen
TRUST_PROXY=192.168.1.1 npm start

# Proxy-Unterstützung deaktivieren
TRUST_PROXY=false npm start
```

### 2. npm proxy-server Setup

Wenn Sie den npm `proxy` Server verwenden:

#### Installation
```bash
npm install -g proxy
```

#### Proxy-Konfiguration

Erstellen Sie eine Proxy-Konfiguration (z.B. `proxy-config.json`):

```json
{
  "routes": {
    "/piano": {
      "target": "http://localhost:3000",
      "changeOrigin": true,
      "pathRewrite": {
        "^/piano": ""
      }
    }
  }
}
```

#### Starten
```bash
# Piano Sheets Server starten
npm start

# In einem anderen Terminal: Proxy starten
proxy --config proxy-config.json --port 8080
```

Nun ist der Server unter `http://localhost:8080/piano` erreichbar.

### 3. nginx Setup

Beispiel nginx-Konfiguration:

```nginx
server {
    listen 80;
    server_name piano.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        
        # Wichtig: Headers für Express trust proxy
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        
        # WebSocket Support für SSE
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass $http_upgrade;
        
        # Timeouts für lange SSE-Verbindungen
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Starten Sie mit:
```bash
TRUST_PROXY=loopback npm start
```

### 3.1 Nginx Proxy Manager Setup

Wenn Sie **Nginx Proxy Manager** (NPM) verwenden:

1. **Öffnen Sie die NPM Web-UI** (normalerweise `http://ihr-server:81`)

2. **Neuen Proxy Host erstellen:**
   - Gehen Sie zu **"Proxy Hosts"** → **"Add Proxy Host"**

3. **Details Tab:**
   ```
   Domain Names:         piano.ihredomain.com
   Scheme:              http
   Forward Hostname/IP: <IP-des-Piano-Servers>
   Forward Port:        3000
   
   ☑ Cache Assets
   ☑ Block Common Exploits
   ☑ Websockets Support
   ```

4. **SSL Tab** (empfohlen):
   ```
   ☑ Request a new SSL Certificate (Let's Encrypt)
   ☑ Force SSL
   ☑ HTTP/2 Support
   ```

5. **Advanced Tab** - Fügen Sie folgenden Code ein:
   ```nginx
   # Proxy Headers für Express
   proxy_set_header Host $host;
   proxy_set_header X-Real-IP $remote_addr;
   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   proxy_set_header X-Forwarded-Proto $scheme;
   proxy_set_header X-Forwarded-Host $host;

   # SSE Support (wichtig für Playlist-Updates)
   proxy_read_timeout 3600s;
   proxy_send_timeout 3600s;
   proxy_buffering off;
   proxy_http_version 1.1;
   proxy_set_header Connection '';
   chunked_transfer_encoding off;
   ```

6. **Speichern** und Piano Server starten:
   ```bash
   npm run start:proxy
   ```

**Wichtig:** Die Advanced-Konfiguration ist essentiell für:
- Korrekte Client-IP-Erkennung (Rate Limiting, Logging)
- SSE-Verbindungen (Playlist-Synchronisation)
- Session-Cookie-Sicherheit bei HTTPS

### 4. Apache Setup

Beispiel Apache VirtualHost (mit mod_proxy):

```apache
<VirtualHost *:80>
    ServerName piano.example.com
    
    ProxyPreserveHost On
    ProxyPass / http://localhost:3000/
    ProxyPassReverse / http://localhost:3000/
    
    # Headers für Express trust proxy
    RequestHeader set X-Forwarded-Proto "http"
    RequestHeader set X-Forwarded-Port "80"
    
    # SSE Support
    ProxyTimeout 3600
</VirtualHost>
```

### 5. Traefik Setup

Beispiel `docker-compose.yml` mit Traefik:

```yaml
version: '3'

services:
  piano-sheets:
    image: node:18
    working_dir: /app
    volumes:
      - .:/app
    command: npm start
    environment:
      - TRUST_PROXY=true
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.piano.rule=Host(`piano.example.com`)"
      - "traefik.http.services.piano.loadbalancer.server.port=3000"
```

## Wichtige Hinweise

### Security Headers
Die folgenden Headers werden vom Server automatisch erkannt, wenn `trust proxy` aktiviert ist:
- `X-Forwarded-For` - Client IP-Adresse
- `X-Forwarded-Proto` - Protokoll (http/https)
- `X-Forwarded-Host` - Original Host
- `X-Real-IP` - Reale IP-Adresse

### Rate Limiting
Rate Limits basieren auf der Client-IP. Mit aktiviertem `trust proxy` wird die echte Client-IP aus den Proxy-Headers verwendet, nicht die Proxy-IP.

### Session Cookies
Bei HTTPS-Proxies stellen Sie sicher, dass:
1. `X-Forwarded-Proto: https` gesetzt ist
2. Der Server erkennt dies automatisch und setzt `Secure` Cookie-Flags

### SSE (Server-Sent Events)
Für Echtzeit-Updates (Playlist-Synchronisation) benötigen Sie:
- Lange Timeout-Werte im Proxy (mind. 1 Stunde)
- WebSocket-Upgrade-Header müssen durchgereicht werden

## Testen

### 1. Grundlegende Erreichbarkeit
```bash
curl http://localhost:8080/piano/
```

### 2. Header-Weiterleitung prüfen
```bash
curl -H "X-Forwarded-For: 1.2.3.4" http://localhost:3000/api/auth/session
```

### 3. SSE-Verbindung testen
```bash
curl -N http://localhost:8080/piano/api/playlist/events
```

## Troubleshooting

### Problem: 502 Bad Gateway
**Lösung:** Server läuft nicht oder Proxy kann nicht verbinden
```bash
# Prüfen Sie ob der Server läuft
netstat -tlnp | grep 3000
```

### Problem: Rate Limiting zeigt Proxy-IP statt Client-IP
**Lösung:** `trust proxy` nicht korrekt konfiguriert
```bash
# Aktivieren Sie trust proxy
TRUST_PROXY=true npm start
```

### Problem: Session Cookies funktionieren nicht
**Lösung:** Proxy muss Host-Header korrekt weiterleiten
```nginx
# nginx
proxy_set_header Host $host;
```

### Problem: SSE-Verbindungen brechen ab
**Lösung:** Timeout-Werte im Proxy erhöhen
```nginx
# nginx
proxy_read_timeout 3600s;
```

## Produktions-Empfehlungen

1. **HTTPS verwenden** - Aktivieren Sie SSL/TLS im Proxy
2. **Rate Limiting** - Konfigurieren Sie auf Proxy-Ebene zusätzlich
3. **Caching** - Statische Assets (PDFs, Thumbnails) können gecacht werden
4. **Monitoring** - Überwachen Sie Proxy-Logs für Fehler
5. **Health Checks** - Implementieren Sie regelmäßige Health-Checks

### Beispiel nginx mit allen Features
```nginx
upstream piano_backend {
    server localhost:3000 max_fails=3 fail_timeout=30s;
}

server {
    listen 443 ssl http2;
    server_name piano.example.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    # Security Headers
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    
    # Caching für statische Assets
    location ~* \.(pdf|jpg|jpeg|png|gif|js|css)$ {
        proxy_pass http://piano_backend;
        proxy_cache_valid 200 7d;
        expires 7d;
    }
    
    # API und dynamische Inhalte
    location / {
        proxy_pass http://piano_backend;
        proxy_http_version 1.1;
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass $http_upgrade;
        
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        
        # Rate Limiting auf Proxy-Ebene
        limit_req zone=piano_limit burst=10 nodelay;
    }
}

# Rate Limit Zone definieren
limit_req_zone $binary_remote_addr zone=piano_limit:10m rate=10r/s;
```

## Support

Bei Problemen oder Fragen:
1. Prüfen Sie die Server-Logs
2. Prüfen Sie die Proxy-Logs
3. Testen Sie direkt ohne Proxy
4. Überprüfen Sie die Header-Weiterleitung

---

**Hinweis:** Diese Konfiguration ist für lokale und produktive Umgebungen optimiert. Passen Sie die Werte an Ihre spezifischen Anforderungen an.
