# Nginx Proxy Manager - SSE (Server-Sent Events) Konfiguration

## Problem
Die Live-Synchronisation bei Playlist Drag & Drop funktioniert nicht hinter Nginx Proxy Manager, weil SSE-Verbindungen durch Proxy-Timeouts unterbrochen werden.

## Lösung

### 1. Server-seitige Fixes (✅ Bereits implementiert)
- **SSE Headers verbessert**: `X-Accel-Buffering: no` verhindert Nginx-Buffering
- **Keep-Alive verkürzt**: 15 Sekunden statt 25 Sekunden (unter typischem 60s Proxy-Timeout)
- **Cache-Control optimiert**: `no-cache, no-transform` statt `no-store`

### 2. Nginx Proxy Manager Konfiguration

#### Option A: In der Web-UI (Custom Nginx Configuration)
Gehe zu deinem Proxy Host für `music.familieklement.com` und füge unter **"Custom Nginx Configuration"** hinzu:

```nginx
# SSE (Server-Sent Events) Support
location /api/playlists/events {
    proxy_pass http://192.168.10.16:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
    
    # Critical for SSE
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;  # 24 hours
    proxy_send_timeout 86400s;  # 24 hours
    chunked_transfer_encoding on;
}

location /api/playlist/events {
    proxy_pass http://192.168.10.16:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
    
    # Critical for SSE
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;  # 24 hours
    proxy_send_timeout 86400s;  # 24 hours
    chunked_transfer_encoding on;
}
```

#### Option B: Direkt in Nginx Config-Datei
Falls du direkten Zugriff auf die Nginx-Config hast:

1. Finde die Config-Datei (meist in `/etc/nginx/sites-available/` oder `/data/nginx/proxy_host/`)
2. Füge die obigen `location`-Blöcke INNERHALB des `server`-Blocks ein
3. Teste die Konfiguration: `nginx -t`
4. Reload Nginx: `systemctl reload nginx` oder `docker exec nginx-proxy-manager nginx -s reload`

### 3. Wichtige Header erklärt

| Header | Zweck |
|--------|-------|
| `X-Accel-Buffering: no` | Verhindert Nginx-Buffering (wird vom Node.js Server gesetzt) |
| `proxy_buffering off` | Deaktiviert Proxy-Buffering in Nginx |
| `proxy_cache off` | Deaktiviert Caching für SSE |
| `proxy_read_timeout 86400s` | Verhindert Timeout bei langen Verbindungen |
| `chunked_transfer_encoding on` | Aktiviert Streaming |
| `Connection: ''` | Leert den Connection-Header (wichtig für HTTP/1.1) |

### 4. Testen

Nach der Konfiguration:

1. **Öffne die App in 2 Browser-Tabs** (z.B. Chrome und Firefox)
2. **Öffne Developer Console** in beiden Tabs
3. **Gehe zu einer Playlist** in beiden Tabs
4. **Drag & Drop ein Item** in Tab 1
5. **✅ Erfolg**: Tab 2 sollte die Änderung sofort sehen
6. **❌ Fehler**: Wenn nicht, prüfe:
   - Browser Console auf Fehler (z.B. `EventSource failed`)
   - Nginx Error Log: `docker logs nginx-proxy-manager` oder `/var/log/nginx/error.log`
   - Network Tab in DevTools: Prüfe ob `/api/playlists/events` aktiv ist

### 5. Troubleshooting

#### Problem: SSE verbindet nicht
```bash
# Prüfe ob der Endpoint erreichbar ist
curl -H "Cookie: your-session-cookie" https://music.familieklement.com/api/playlists/events
```

#### Problem: Verbindung bricht nach 60 Sekunden ab
- **Ursache**: Nginx `proxy_read_timeout` ist zu niedrig
- **Lösung**: Setze `proxy_read_timeout 86400s;` in der Location-Config

#### Problem: Keine Live-Updates trotz Verbindung
- **Ursache**: Buffering ist aktiviert
- **Lösung**: Prüfe ob `proxy_buffering off;` gesetzt ist

### 6. Alternative: Nginx Proxy Manager UI

Falls die Custom Config nicht funktioniert:

1. Gehe zu **Proxy Hosts** → Dein Host → **Advanced** Tab
2. Füge unter "Custom Nginx Configuration" ein:
```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 86400;
proxy_send_timeout 86400;
```

## Status
- ✅ Server-Code angepasst (SSE Headers + Keep-Alive)
- ⏳ Nginx Proxy Manager Konfiguration erforderlich (siehe oben)

## Referenzen
- [Nginx SSE Documentation](https://www.nginx.com/blog/event-driven-data-management-nginx/)
- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
