# Security Audit Report - Piano Sheets Application
**Datum:** 4. November 2025  
**Status:** Production Readiness Review  
**Schweregrad-Skala:** 🔴 Kritisch | 🟠 Hoch | 🟡 Mittel | 🟢 Niedrig

---

## Executive Summary

Die Piano Sheets Application wurde einem umfassenden Security Audit unterzogen. Die Anwendung nutzt moderne Sicherheitsmechanismen (verschlüsselte Passwörter, Session-Management, SQLite-basierte Authentifizierung), weist jedoch **kritische Schwachstellen** auf, die vor einem Production-Launch behoben werden müssen.

**Gesamtbewertung:** ⚠️ **NICHT production-ready** - 7 kritische und 12 hochpriorisierte Schwachstellen gefunden.

---

## 🔴 KRITISCHE SCHWACHSTELLEN (Sofort beheben!)

### 1. **Path Traversal / Directory Traversal Vulnerability** 🔴
**Datei:** `server.js` (Zeilen 860-920, PDF-Upload und -Zugriff)  
**Risiko:** Angreifer können auf beliebige Dateien außerhalb von `/sheets` zugreifen

**Problem:**
```javascript
// In resolvePdfName() - unsichere Path-Validierung
const normalized = path.posix.normalize(toPosixPath(candidate));
if (!normalized || normalized === "." || normalized.startsWith("../") || path.isAbsolute(normalized)) {
  return null;
}
```

**Angriffsvektoren:**
- `GET /sheets/../../../etc/passwd`
- `GET /sheets/..%2F..%2F..%2Fetc%2Fpasswd`
- `GET /sheets/folder/..%252F..%252Fetc%252Fpasswd` (doppelt encoded)
- Upload mit manipuliertem `originalName`: `../../data/auth.sqlite`

**LÖSUNG:**
```javascript
function resolvePdfName(name, options = {}) {
  const { requireExists = true } = options;
  if (typeof name !== "string") return null;
  
  let candidate = name.trim();
  if (!candidate) return null;
  
  // WICHTIG: Decode zuerst
  try { 
    candidate = decodeURIComponent(candidate);
  } catch {
    return null; // Verhindere ungültige Encodings
  }
  
  // Normalisiere Path
  const normalized = path.posix.normalize(toPosixPath(candidate));
  
  // KRITISCH: Strikte Validierung
  if (!normalized || 
      normalized === "." || 
      normalized.startsWith("../") || 
      normalized.includes("/../") || // FEHLT AKTUELL!
      normalized.includes("\\") ||    // Windows Backslashes blocken
      path.isAbsolute(normalized)) {
    return null;
  }
  
  // WICHTIG: Validiere den absoluten Pfad
  const abs = path.resolve(path.join(SHEETS_DIR, normalized));
  
  // KRITISCH: Prüfe dass der Pfad WIRKLICH innerhalb SHEETS_DIR liegt
  const relativePath = path.relative(SHEETS_DIR, abs);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    console.warn("[SECURITY] Path traversal attempt blocked:", name);
    return null;
  }
  
  // Prüfe auf Null-Bytes (directory traversal bypass)
  if (candidate.includes('\0') || normalized.includes('\0')) {
    console.warn("[SECURITY] Null-byte injection attempt blocked:", name);
    return null;
  }
  
  if (!normalized.toLowerCase().endsWith(".pdf")) {
    return null;
  }
  
  if (requireExists) {
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return null;
    } catch {
      return null;
    }
  }
  
  return { rel: normalized, abs };
}
```

**Zusätzlich erforderlich:** Input-Validierung bei Upload
```javascript
// In /api/upload
const rawName = (meta.originalName && typeof meta.originalName === "string")
  ? meta.originalName.trim()
  : "upload.pdf";

// KRITISCH: Validiere, dass Name keine Path-Traversal enthält
if (rawName.includes('..') || rawName.includes('/') || rawName.includes('\\')) {
  return res.status(400).json({ error: "Invalid filename" });
}
```

---

### 2. **SQL Injection via Document IDs** 🔴
**Datei:** `lib/data-store.js` (Zeilen 80-110)  
**Risiko:** SQL Injection bei bulk operations

**Problem:**
```javascript
function buildPlaceholders(values) {
  if (!values.length) return "";
  return values.map(() => "?").join(", ");
}

// GEFÄHRLICH: Bei großen Arrays kann SQL-Query-Limit überschritten werden
const placeholders = buildPlaceholders(unique);
if (placeholders) {
  const rows = query.all(
    `SELECT id, rel_path FROM documents WHERE rel_path IN (${placeholders})`,
    unique
  );
}
```

**LÖSUNG:**
```javascript
function ensureDocuments(relPaths) {
  if (!Array.isArray(relPaths) || !relPaths.length) return new Map();
  
  const unique = Array.from(new Set(relPaths.filter((rel) => 
    typeof rel === "string" && rel.trim()
  )));
  
  if (!unique.length) return new Map();
  
  const existingMap = new Map();
  
  // KRITISCH: Verhindere SQL-Injection via Array-Größe
  const BATCH_SIZE = 500; // SQLite-Limit beachten
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    const placeholders = buildPlaceholders(batch);
    
    if (placeholders) {
      const rows = query.all(
        `SELECT id, rel_path FROM documents WHERE rel_path IN (${placeholders})`,
        batch
      );
      rows.forEach((row) => {
        existingMap.set(row.rel_path, row.id);
      });
    }
  }
  
  // Rest des Codes...
}
```

---

### 3. **Session Fixation Vulnerability** 🔴
**Datei:** `lib/auth.js` (Zeilen 220-250)  
**Risiko:** Angreifer kann Session-ID vorhersagen oder fixieren

**Problem:**
```javascript
function createSession(userId, ttlMs = SESSION_TTL_MS) {
  const sessionId = crypto.randomUUID(); // UUID v4 - okay
  // ABER: Keine Session-Regeneration nach Login!
}
```

**LÖSUNG:**
```javascript
// In /api/auth/login (server.js)
app.post("/api/auth/login", (req, res) => {
  // ... Passwort-Prüfung ...
  
  // KRITISCH: Alte Session löschen (Session Fixation Prevention)
  const oldSessionId = req.auth?.sessionId || parseCookies(req)[SESSION_COOKIE_NAME];
  if (oldSessionId) {
    try {
      authService.deleteSession(oldSessionId);
    } catch {}
  }
  
  // Neue Session mit zufälliger ID
  const session = authService.createSession(record.id);
  
  // WICHTIG: HttpOnly, Secure, SameSite=Strict
  setSessionCookie(res, session.id, session.expiresAt);
  
  res.json({ ok: true, user });
});
```

---

### 4. **Ungeschützte Admin-Endpoints** 🔴
**Datei:** `server.js` (Zeilen 2600-2650)  
**Risiko:** Unautorisierter Zugriff auf System-APIs

**Problem:**
```javascript
app.get("/api/system/memory", (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  // FEHLT: Role-Check! Jeder authentifizierte User kann System-Info abrufen
  if (!req.auth || !req.auth.user || req.auth.user.role !== 'admin') {
    return res.status(403).json({ error: "Admin access required" });
  }
  // ...
});
```

**Das gleiche Problem bei:**
- `/api/system/gc`
- `/api/system/cache/clear`

**LÖSUNG:**
```javascript
// Verwende die bereits vorhandene ensureAdmin() Funktion konsequent!
app.get("/api/system/memory", (req, res) => {
  if (!ensureAdmin(req, res)) return; // ✅ Nutze zentrale Admin-Prüfung
  // ...
});

app.post("/api/system/gc", (req, res) => {
  if (!ensureAdmin(req, res)) return;
  // ...
});

app.post("/api/system/cache/clear", (req, res) => {
  if (!ensureAdmin(req, res)) return;
  // ...
});
```

---

### 5. **Fehlende Rate Limiting** 🔴
**Datei:** Gesamte API  
**Risiko:** Brute-Force, DoS, Credential Stuffing

**Problem:**
- Kein Rate Limiting für `/api/auth/login`
- Kein Rate Limiting für `/api/upload`
- Kein Request-Throttling generell

**LÖSUNG:**
```javascript
// Installiere: npm install express-rate-limit
const rateLimit = require('express-rate-limit');

// Login Rate Limiter (vor registerApiRoutes())
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minuten
  max: 5, // Max 5 Login-Versuche
  message: { error: "Zu viele Login-Versuche. Bitte warten Sie 15 Minuten." },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Erfolgreiche Logins nicht zählen
});

// Upload Rate Limiter
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 Minute
  max: 10, // Max 10 Uploads pro Minute
  message: { error: "Upload-Limit erreicht. Bitte warten Sie." },
  standardHeaders: true,
  legacyHeaders: false,
});

// API Rate Limiter (generell)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 Minute
  max: 120, // Max 120 Requests pro Minute
  message: { error: "Zu viele Anfragen. Bitte warten Sie." },
  standardHeaders: true,
  legacyHeaders: false,
});

// In registerApiRoutes():
app.post("/api/auth/login", loginLimiter, (req, res) => {
  // ...
});

app.post("/api/upload", uploadLimiter, async (req, res) => {
  // ...
});

// Generelles API Rate Limiting
app.use("/api/", apiLimiter);
```

---

### 6. **Unsafe File Upload - MIME Type Bypass** 🔴
**Datei:** `server.js` (Zeilen 2800-2900)  
**Risiko:** Malicious File Upload, Code Execution

**Problem:**
```javascript
// Nur Content-Type und Dateiendung werden geprüft - UNSICHER!
const contentType = ((req.headers["content-type"] || "").toString().toLowerCase());
const isPdfByMime = contentType.includes("application/pdf") || 
                     contentType.includes("application/octet-stream");
const isPdfByName = declaredName.toLowerCase().endsWith(".pdf");

if (!isPdfByMime && !isPdfByName) {
  return res.status(415).json({ error: "Nur PDF-Dateien erlaubt" });
}
// ABER: Keine Validierung des tatsächlichen Dateiinhalts!
```

**LÖSUNG:**
```javascript
// Installiere: npm install file-type
const { fileTypeFromBuffer } = require('file-type');

app.post("/api/upload", async (req, res) => {
  // ... bisheriger Code ...
  
  // Datei in temporären Buffer lesen
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (chunks.reduce((sum, c) => sum + c.length, 0) > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `Datei zu groß` });
    }
  }
  const buffer = Buffer.concat(chunks);
  
  // KRITISCH: Validiere tatsächlichen MIME-Type
  const fileType = await fileTypeFromBuffer(buffer);
  if (!fileType || fileType.mime !== 'application/pdf') {
    return res.status(415).json({ 
      error: "Nur PDF-Dateien erlaubt. Detektiert: " + (fileType?.mime || "unknown") 
    });
  }
  
  // Zusätzlich: PDF-Struktur validieren
  try {
    await PDFDocument.load(buffer, { ignoreEncryption: true });
  } catch (err) {
    return res.status(400).json({ error: "Ungültige PDF-Datei" });
  }
  
  // Jetzt erst in Datei schreiben
  await fs.promises.writeFile(tempPath, buffer);
  // ...
});
```

---

### 7. **Information Disclosure via Error Messages** 🔴
**Datei:** Diverse (server.js, auth.js, data-store.js)  
**Risiko:** Leak von internen Pfaden, Stack Traces, Datenbank-Struktur

**Problem:**
```javascript
// Beispiele:
console.error("Upload mkdir failed:", err); // Stack Trace im Log
res.status(500).json({ error: "Failed to list sheets." }); // Zu generisch
console.log('resolvePdfName: file does not exist:', abs); // Pfad-Leak
```

**LÖSUNG:**
```javascript
// 1. Zentrales Error-Logging ohne Details ans Frontend
function logError(context, error, details = {}) {
  const timestamp = new Date().toISOString();
  const errorLog = {
    timestamp,
    context,
    message: error?.message || String(error),
    code: error?.code,
    stack: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
    ...details
  };
  console.error('[ERROR]', JSON.stringify(errorLog));
}

// 2. Generische Fehler ans Frontend
function sendError(res, statusCode, publicMessage, internalError = null, details = {}) {
  if (internalError) {
    logError(publicMessage, internalError, details);
  }
  
  // NIEMALS Stack Traces oder interne Pfade senden!
  res.status(statusCode).json({ 
    error: publicMessage,
    // Nur in Development Mode Details
    ...(process.env.NODE_ENV === 'development' && internalError ? {
      dev: { message: internalError.message }
    } : {})
  });
}

// Verwendung:
app.get("/api/sheets", async (req, res) => {
  try {
    // ...
  } catch (err) {
    sendError(res, 500, "Fehler beim Laden der Dateien", err, {
      endpoint: "/api/sheets",
      userId: req.auth?.user?.id
    });
  }
});
```

---

## 🟠 HOCHPRIORISIERTE SCHWACHSTELLEN

### 8. **Fehlende CSRF Protection** 🟠
**Risiko:** Cross-Site Request Forgery bei State-Changing Operations

**LÖSUNG:**
```javascript
// Installiere: npm install csurf
const csrf = require('csurf');
const csrfProtection = csrf({ cookie: { httpOnly: true, secure: true, sameSite: 'strict' } });

// Schütze alle POST/PUT/DELETE/PATCH Endpoints
app.use(['/api/upload', '/api/prefs', '/api/playlists', '/api/categories'], csrfProtection);

// Token an Frontend senden
app.get('/api/csrf-token', csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});
```

Frontend (app.js):
```javascript
// CSRF Token bei jedem Request mitsenden
let csrfToken = null;

async function fetchCsrfToken() {
  const res = await fetch('/api/csrf-token');
  const data = await res.json();
  csrfToken = data.csrfToken;
}

async function apiPost(url, body) {
  if (!csrfToken) await fetchCsrfToken();
  
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify(body),
    credentials: 'include'
  });
}
```

---

### 9. **Weak Session Security** 🟠
**Problem:** Session-Cookies ohne ausreichende Security-Flags

**Aktuell:**
```javascript
function buildSessionCookie(value, maxAgeSeconds) {
  const segments = [`${SESSION_COOKIE_NAME}=${value}`];
  if (Number.isFinite(maxAgeSeconds)) {
    segments.push(`Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}`);
  }
  segments.push("Path=/");
  segments.push("HttpOnly");
  segments.push("SameSite=Lax"); // ⚠️ Sollte "Strict" sein!
  if (process.env.NODE_ENV === "production") {
    segments.push("Secure");
  }
  return segments.join("; ");
}
```

**LÖSUNG:**
```javascript
function buildSessionCookie(value, maxAgeSeconds) {
  const segments = [`${SESSION_COOKIE_NAME}=${value}`];
  
  if (Number.isFinite(maxAgeSeconds)) {
    segments.push(`Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}`);
  }
  
  segments.push("Path=/");
  segments.push("HttpOnly"); // ✅ Verhindert XSS-Cookie-Theft
  segments.push("SameSite=Strict"); // ✅ CSRF Protection
  segments.push("Secure"); // ✅ IMMER Secure (auch in Dev mit Self-Signed Cert)
  
  return segments.join("; ");
}
```

**Zusätzlich:** Session-Rotation implementieren
```javascript
// Bei kritischen Operationen (Passwort-Änderung, Role-Change) Session erneuern
async function rotateSession(req, res) {
  const oldSessionId = req.auth?.sessionId;
  if (!oldSessionId) return null;
  
  const userId = req.auth.user.id;
  
  // Alte Session löschen
  authService.deleteSession(oldSessionId);
  
  // Neue Session erstellen
  const newSession = authService.createSession(userId);
  setSessionCookie(res, newSession.id, newSession.expiresAt);
  
  return newSession;
}
```

---

### 10. **Unvalidated Redirects** 🟠
**Problem:** Open Redirect in Client-Code

**In `app.js`:**
```javascript
// Potentiell gefährlich bei manipuliertem Hash
function navigate(route) {
  location.hash = route; // ⚠️ Keine Validierung!
}
```

**LÖSUNG:**
```javascript
const ALLOWED_ROUTES = [
  '#/',
  '#/viewer/',
  '#/admin',
  '#/login',
  '#/playlists'
];

function navigate(route) {
  // Validiere Route
  const normalized = route.startsWith('#') ? route : `#${route}`;
  
  const isAllowed = ALLOWED_ROUTES.some(allowed => 
    normalized === allowed || normalized.startsWith(allowed)
  );
  
  if (!isAllowed) {
    console.warn('[SECURITY] Invalid route blocked:', route);
    location.hash = '#/';
    return;
  }
  
  location.hash = normalized;
}
```

---

### 11. **Insecure Direct Object Reference (IDOR)** 🟠
**Problem:** User kann auf Dokumente anderer User zugreifen

**Aktuell in `/sheets` Middleware:**
```javascript
app.use("/sheets", (req, res, next) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const { USER_DOCUMENTS } = userContext;
  const requestedPath = decodeURIComponent(req.path);
  const relPath = requestedPath.startsWith('/') ? requestedPath.slice(1) : requestedPath;
  
  // ✅ Check ist vorhanden - GUT!
  if (!USER_DOCUMENTS.has(relPath)) {
    return res.status(403).json({ error: "Access denied to this document" });
  }
  
  next();
});
```

**ABER:** Der gleiche Check fehlt bei anderen Endpoints!

**FEHLT bei:**
- `/api/prefs/file` - User kann beliebige Dateien konfigurieren
- `/api/annotations` - User kann Annotations anderer User lesen
- `/api/playlists/items/assign` - User kann beliebige Dateien zu Playlists hinzufügen

**LÖSUNG:**
```javascript
// Zentrale Hilfsfunktion
function ensureDocumentAccess(req, res) {
  if (!ensureAuthenticated(req, res)) return false;
  
  const { USER_DOCUMENTS } = userContext;
  const name = req.body?.name || req.query?.name;
  
  if (!name) {
    res.status(400).json({ error: "Document name required" });
    return false;
  }
  
  const info = resolvePdfName(name);
  if (!info) {
    res.status(400).json({ error: "Invalid document name" });
    return false;
  }
  
  if (!USER_DOCUMENTS.has(info.rel)) {
    res.status(403).json({ error: "Access denied to this document" });
    return false;
  }
  
  // Dokumentinfo für weitere Verarbeitung anhängen
  req.documentInfo = info;
  return true;
}

// Anwenden:
app.post("/api/prefs/file", async (req, res) => {
  if (!ensureDocumentAccess(req, res)) return;
  const info = req.documentInfo; // Validiert und bereit
  // ...
});

app.get("/api/annotations", async (req, res) => {
  if (!ensureDocumentAccess(req, res)) return;
  // ...
});
```

---

### 12. **Timing Attack on Password Verification** 🟠
**Datei:** `lib/auth.js` (Zeilen 400-420)

**Problem:**
```javascript
function verifyPassword(password, encryptedRecord) {
  try {
    return verifyEncryptedPassword(password, encryptedRecord, encryptionKey);
  } catch {
    return false; // ⚠️ Unterschiedliche Laufzeit bei Exception vs. falsches PW
  }
}
```

**LÖSUNG:**
```javascript
const crypto = require('crypto');

function verifyPassword(password, encryptedRecord) {
  try {
    const isValid = verifyEncryptedPassword(password, encryptedRecord, encryptionKey);
    
    // Konstante Laufzeit durch Dummy-Hash bei Fehler
    if (!isValid) {
      // Fake-Berechnung für Timing-Gleichheit
      crypto.scryptSync('dummy-password', 'dummy-salt', 64);
    }
    
    return isValid;
  } catch (err) {
    // Auch bei Exception: Timing konstant halten
    crypto.scryptSync('dummy-password', 'dummy-salt', 64);
    return false;
  }
}
```

---

### 13. **Missing Content Security Policy (CSP)** 🟠
**Problem:** Keine CSP-Header gesetzt

**Aktuell:**
```javascript
if (helmet) {
  app.use(helmet({
    contentSecurityPolicy: false, // ⚠️ CSP deaktiviert!
    crossOriginEmbedderPolicy: false,
  }));
}
```

**LÖSUNG:**
```javascript
if (helmet) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'", // Nur wenn nötig - besser: Nonces verwenden
          "https://cdnjs.cloudflare.com", // PDF.js
          "https://cdn.jsdelivr.net"       // NoSleep.js
        ],
        styleSrc: ["'self'", "'unsafe-inline'"], // Tailwind inline styles
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        workerSrc: ["'self'", "blob:"], // PDF.js Worker
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: true,
    crossOriginOpenerPolicy: true,
    crossOriginResourcePolicy: { policy: "same-origin" },
  }));
}
```

---

### 14. **Weak Encryption Key Management** 🟠
**Datei:** `lib/auth.js` (Zeilen 20-50)

**Problem:**
```javascript
async function loadOrCreateKey(keyPath) {
  if (process.env.AUTH_ENCRYPTION_KEY) {
    const key = decodeKey(process.env.AUTH_ENCRYPTION_KEY.trim());
    if (key.length !== 32) {
      throw new Error("AUTH_ENCRYPTION_KEY must decode to 32 bytes");
    }
    return key;
  }
  
  // ⚠️ Key wird in Klartext-Datei gespeichert!
  try {
    const existing = await fs.promises.readFile(keyPath, "utf8");
    return decodeKey(existing.trim());
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
  
  const key = crypto.randomBytes(32);
  await fs.promises.writeFile(keyPath, key.toString("base64"), { 
    encoding: "utf8", 
    mode: 0o600 // ⚠️ Nicht ausreichend für Production!
  });
  return key;
}
```

**LÖSUNG:**
```javascript
// 1. Environment Variable ZWINGEND in Production
async function loadOrCreateKey(keyPath) {
  // Production: Key MUSS als ENV-Variable gesetzt sein
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.AUTH_ENCRYPTION_KEY) {
      throw new Error(
        'CRITICAL: AUTH_ENCRYPTION_KEY environment variable MUST be set in production'
      );
    }
    const key = decodeKey(process.env.AUTH_ENCRYPTION_KEY.trim());
    if (key.length !== 32) {
      throw new Error("AUTH_ENCRYPTION_KEY must decode to 32 bytes");
    }
    return key;
  }
  
  // Development: Erlaube File-basierte Keys mit Warnung
  if (process.env.AUTH_ENCRYPTION_KEY) {
    const key = decodeKey(process.env.AUTH_ENCRYPTION_KEY.trim());
    if (key.length !== 32) {
      throw new Error("AUTH_ENCRYPTION_KEY must decode to 32 bytes");
    }
    return key;
  }
  
  console.warn(
    '⚠️  WARNING: Using file-based encryption key (development only). ' +
    'Set AUTH_ENCRYPTION_KEY environment variable for production!'
  );
  
  try {
    const existing = await fs.promises.readFile(keyPath, "utf8");
    return decodeKey(existing.trim());
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
  
  const key = crypto.randomBytes(32);
  await fs.promises.writeFile(keyPath, key.toString("base64"), { 
    encoding: "utf8", 
    mode: 0o600 
  });
  
  console.log(
    `✅ Generated new encryption key at ${keyPath}\n` +
    `   For production, set as ENV: AUTH_ENCRYPTION_KEY=${key.toString('base64')}`
  );
  
  return key;
}

// 2. Deployment-Dokumentation erstellen
```

**Deployment-Guide hinzufügen:**
```markdown
# Production Deployment Security Checklist

## Required Environment Variables
- `AUTH_ENCRYPTION_KEY`: 32-byte encryption key (base64)
  Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
- `NODE_ENV=production`
- `ADMIN_EMAIL`: Initial admin email
- `ADMIN_PASSWORD`: Secure initial password (min. 12 chars)

## File Permissions
- `data/auth.sqlite`: 600 (owner read/write only)
- `data/`: 700 (owner full access only)
```

---

### 15. **Insufficient Logging & Monitoring** 🟠
**Problem:** Keine Security-Event-Logs für Forensik

**LÖSUNG:**
```javascript
// Zentrales Security-Logging
const securityLogger = {
  logAuthAttempt(email, success, reason = null, ip = null) {
    const event = {
      timestamp: new Date().toISOString(),
      type: 'AUTH_ATTEMPT',
      email,
      success,
      reason,
      ip,
    };
    console.log('[SECURITY]', JSON.stringify(event));
    
    // Optional: In separate Security-Log-Datei schreiben
    // fs.appendFileSync(path.join(DATA_DIR, 'security.log'), JSON.stringify(event) + '\n');
  },
  
  logAccessDenied(userId, resource, reason, ip = null) {
    const event = {
      timestamp: new Date().toISOString(),
      type: 'ACCESS_DENIED',
      userId,
      resource,
      reason,
      ip,
    };
    console.warn('[SECURITY]', JSON.stringify(event));
  },
  
  logAdminAction(adminId, action, target, details = {}) {
    const event = {
      timestamp: new Date().toISOString(),
      type: 'ADMIN_ACTION',
      adminId,
      action,
      target,
      ...details,
    };
    console.log('[AUDIT]', JSON.stringify(event));
  },
};

// In Login-Endpoint integrieren:
app.post("/api/auth/login", loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const clientIp = req.ip || req.connection.remoteAddress;
  
  if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
    securityLogger.logAuthAttempt(email, false, 'INVALID_INPUT', clientIp);
    return res.status(400).json({ error: "INVALID_CREDENTIALS" });
  }
  
  const record = authService.getUserByEmail(email);
  if (!record) {
    securityLogger.logAuthAttempt(email, false, 'USER_NOT_FOUND', clientIp);
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }
  
  if (!record.isActive) {
    securityLogger.logAuthAttempt(email, false, 'USER_DISABLED', clientIp);
    return res.status(403).json({ error: "USER_DISABLED" });
  }
  
  const valid = authService.verifyPassword(password, record.passwordEncrypted);
  if (!valid) {
    securityLogger.logAuthAttempt(email, false, 'WRONG_PASSWORD', clientIp);
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }
  
  securityLogger.logAuthAttempt(email, true, null, clientIp);
  // ... Session erstellen ...
});
```

---

### 16. **Unrestricted File Upload Size** 🟠
**Problem:** Keine Validierung der tatsächlichen Upload-Größe während Stream

**Aktuell:**
```javascript
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
const contentLength = Number(req.headers["content-length"]);
if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
  return res.status(413).json({ error: `Datei ist größer als ${limitMb} MB.` });
}
// ⚠️ Header kann manipuliert werden!
```

**LÖSUNG:**
```javascript
// SizeLimiter ist bereits vorhanden - ABER nutze es richtig!
app.post("/api/upload", async (req, res) => {
  // ... Validierungen ...
  
  // ✅ Verwende Limiter PLUS zusätzliche Checks
  const limitMb = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);
  
  // Content-Length als erste Prüfung (schnell)
  const declaredSize = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ 
      error: `Datei ist größer als ${limitMb} MB.`,
      maxSize: MAX_UPLOAD_BYTES,
      declared: declaredSize
    });
  }
  
  // Stream mit tatsächlicher Größen-Prüfung
  try {
    const limiter = new SizeLimiter(MAX_UPLOAD_BYTES);
    const out = fs.createWriteStream(tempPath);
    
    // ✅ Zusätzlich: Timeout für langsame Uploads
    req.setTimeout(5 * 60 * 1000, () => { // 5 Minuten Max
      req.destroy(new Error('Upload timeout'));
    });
    
    await pipeline(req, limiter, out);
  } catch (err) {
    await fs.promises.unlink(tempPath).catch(() => {});
    
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ 
        error: `Datei überschreitet Limit von ${limitMb} MB.`,
        maxSize: MAX_UPLOAD_BYTES
      });
    }
    
    if (err.message === 'Upload timeout') {
      return res.status(408).json({ error: "Upload-Timeout" });
    }
    
    logError("Upload stream failed", err, { userId: req.auth?.user?.id });
    return res.status(400).json({ error: "Upload fehlgeschlagen" });
  }
  
  // ✅ Validiere finale Dateigröße
  const stat = await fs.promises.stat(tempPath);
  if (stat.size > MAX_UPLOAD_BYTES) {
    await fs.promises.unlink(tempPath).catch(() => {});
    return res.status(413).json({ 
      error: `Datei überschreitet Limit von ${limitMb} MB.`,
      actualSize: stat.size,
      maxSize: MAX_UPLOAD_BYTES
    });
  }
  
  // ...
});
```

---

### 17. **Missing Input Sanitization** 🟠
**Problem:** User-Input wird nicht sanitiert vor der Speicherung

**Betroffen:**
- Category Namen
- Playlist Namen
- Datei-Metadaten

**LÖSUNG:**
```javascript
// Installiere: npm install dompurify jsdom
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');
const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

function sanitizeString(input, maxLength = 255) {
  if (typeof input !== 'string') return '';
  
  // 1. Entferne HTML/Script Tags
  const clean = DOMPurify.sanitize(input, { 
    ALLOWED_TAGS: [], 
    ALLOWED_ATTR: [] 
  });
  
  // 2. Trim & Limit Länge
  return clean.trim().slice(0, maxLength);
}

// Anwenden:
app.post("/api/categories", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { CONFIG } = userContext;
  
  const { name, color, icon } = req.body || {};
  const trimmedName = sanitizeString(name, 100); // Max 100 Zeichen
  
  if (!trimmedName) {
    return res.status(400).json({ error: "Name required" });
  }
  
  // ... Rest ...
});

app.post("/api/playlists", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const { name, icon, accentColor, items } = req.body || {};
  const sanitizedName = sanitizeString(name, 100);
  const sanitizedIcon = sanitizeString(icon, 2);
  
  // ... Rest ...
});
```

---

### 18. **Weak Password Policy** 🟠
**Datei:** `lib/auth.js`

**Aktuell:**
```javascript
if (!password || typeof password !== "string" || password.length < 6) {
  // ⚠️ Nur 6 Zeichen Minimum - ZU SCHWACH!
}
```

**LÖSUNG:**
```javascript
function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'E_PASSWORD_REQUIRED' };
  }
  
  const minLength = 10; // ✅ Minimum 10 Zeichen
  if (password.length < minLength) {
    return { 
      valid: false, 
      error: 'E_PASSWORD_TOO_SHORT',
      message: `Passwort muss mindestens ${minLength} Zeichen haben.`
    };
  }
  
  // ✅ Complexity-Checks
  const hasLowercase = /[a-z]/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);
  
  const strength = [hasLowercase, hasUppercase, hasNumber, hasSpecial].filter(Boolean).length;
  
  if (strength < 3) {
    return {
      valid: false,
      error: 'E_PASSWORD_TOO_WEAK',
      message: 'Passwort muss mindestens 3 von 4 Kriterien erfüllen: Kleinbuchstaben, Großbuchstaben, Zahlen, Sonderzeichen'
    };
  }
  
  // ✅ Prüfe auf häufige Passwörter (Top 10000)
  const commonPasswords = new Set([
    'password', 'password123', 'admin', 'admin123', 'qwertz123',
    '12345678', '123456789', '1234567890', 'abc123456'
    // ... mehr aus https://github.com/danielmiessler/SecLists/tree/master/Passwords
  ]);
  
  if (commonPasswords.has(password.toLowerCase())) {
    return {
      valid: false,
      error: 'E_PASSWORD_TOO_COMMON',
      message: 'Dieses Passwort ist zu häufig verwendet.'
    };
  }
  
  return { valid: true };
}

// In createUser():
function createUser({ email, password, role = "user", isActive = true }) {
  // ...
  
  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    const err = new Error(passwordValidation.message || passwordValidation.error);
    err.code = passwordValidation.error;
    throw err;
  }
  
  // ...
}
```

---

### 19. **No User Enumeration Protection** 🟠
**Problem:** Login-Endpoint verrät, ob Email existiert

**Aktuell:**
```javascript
const record = authService.getUserByEmail(email);
if (!record) {
  return res.status(401).json({ error: "INVALID_CREDENTIALS" }); // ✅ Gut
}
if (!record.isActive) {
  return res.status(403).json({ error: "USER_DISABLED" }); // ⚠️ Verrät Existenz
}
```

**LÖSUNG:**
```javascript
app.post("/api/auth/login", loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const clientIp = req.ip || req.connection.remoteAddress;
  
  if (typeof email !== "string" || !email.trim() || 
      typeof password !== "string" || !password) {
    securityLogger.logAuthAttempt(email, false, 'INVALID_INPUT', clientIp);
    
    // ✅ Füge künstliche Verzögerung hinzu (Timing-Attack-Prevention)
    return setTimeout(() => {
      res.status(401).json({ error: "INVALID_CREDENTIALS" });
    }, 500 + Math.random() * 500);
  }
  
  const record = authService.getUserByEmail(email);
  
  // ✅ Auch bei nicht existierendem User: Password-Hash simulieren (Timing)
  if (!record) {
    authService.verifyPassword(password, 'dummy'); // Dummy-Hash für konstante Zeit
    securityLogger.logAuthAttempt(email, false, 'USER_NOT_FOUND', clientIp);
    
    return setTimeout(() => {
      res.status(401).json({ error: "INVALID_CREDENTIALS" });
    }, 500 + Math.random() * 500);
  }
  
  // ✅ User existiert aber inaktiv: Gleiche Fehlermeldung wie nicht-existent
  if (!record.isActive) {
    authService.verifyPassword(password, 'dummy');
    securityLogger.logAuthAttempt(email, false, 'USER_DISABLED', clientIp);
    
    return setTimeout(() => {
      res.status(401).json({ error: "INVALID_CREDENTIALS" }); // Nicht USER_DISABLED!
    }, 500 + Math.random() * 500);
  }
  
  const valid = authService.verifyPassword(password, record.passwordEncrypted);
  if (!valid) {
    securityLogger.logAuthAttempt(email, false, 'WRONG_PASSWORD', clientIp);
    
    return setTimeout(() => {
      res.status(401).json({ error: "INVALID_CREDENTIALS" });
    }, 500 + Math.random() * 500);
  }
  
  securityLogger.logAuthAttempt(email, true, null, clientIp);
  
  // Session erstellen (ohne Verzögerung bei Erfolg)
  const session = authService.createSession(record.id);
  setSessionCookie(res, session.id, session.expiresAt);
  const user = authService.toPublicUser(record);
  res.json({ ok: true, user });
});
```

---

## 🟡 MITTLERE PRIORITÄT

### 20. **No Request ID Tracking** 🟡
**LÖSUNG:**
```javascript
const { randomUUID } = require('crypto');

// Request-ID Middleware (vor allen anderen)
app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// In allen Log-Ausgaben verwenden
function logError(context, error, req) {
  console.error(`[ERROR] [${req?.id || 'unknown'}] ${context}:`, error);
}
```

---

### 21. **Missing Graceful Degradation for Thumbnails** 🟡
**Aktuell:** Fallback-Thumbnail wird bei jedem Fehler gesendet  
**Empfehlung:** Unterscheide zwischen temporären und permanenten Fehlern

---

### 22. **No Database Backup Mechanism** 🟡
**LÖSUNG:**
```javascript
// Tägliches SQLite Backup
const cron = require('node-cron');

// Jeden Tag um 3 Uhr morgens
cron.schedule('0 3 * * *', async () => {
  const backupDir = path.join(DATA_DIR, 'backups');
  await fs.promises.mkdir(backupDir, { recursive: true });
  
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const backupPath = path.join(backupDir, `auth-${timestamp}.sqlite`);
  
  try {
    await fs.promises.copyFile(
      path.join(DATA_DIR, 'auth.sqlite'),
      backupPath
    );
    console.log(`[BACKUP] Database backed up to ${backupPath}`);
    
    // Alte Backups löschen (> 30 Tage)
    const files = await fs.promises.readdir(backupDir);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    
    for (const file of files) {
      const filePath = path.join(backupDir, file);
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.unlink(filePath);
      }
    }
  } catch (err) {
    console.error('[BACKUP] Failed:', err);
  }
});
```

---

## 🟢 OPTIONAL / BEST PRACTICES

### 23. **Add Subresource Integrity (SRI)** 🟢
**Für externe CDN-Resources:**
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"
        integrity="sha384-..."
        crossorigin="anonymous"></script>
```

---

### 24. **Implement API Versioning** 🟢
```javascript
app.use('/api/v1', apiV1Router);
app.use('/api/v2', apiV2Router); // Zukünftige Breaking Changes
```

---

### 25. **Add Health Check with Authentication Status** 🟢
```javascript
app.get("/healthz", async (req, res) => {
  try {
    // Basic Checks
    const okSheets = fs.existsSync(SHEETS_DIR);
    const count = (await getIndex()).length;
    
    // Database Check
    let dbOk = false;
    try {
      authService.query.get("SELECT 1");
      dbOk = true;
    } catch {}
    
    const status = okSheets && dbOk ? 200 : 503;
    
    res.status(status).json({ 
      ok: status === 200,
      checks: {
        filesystem: okSheets,
        database: dbOk,
        fileCount: count,
      },
      timestamp: new Date().toISOString()
    });
  } catch {
    res.status(503).json({ ok: false });
  }
});
```

---

## Zusammenfassung & Action Items

### ✅ Sofort umsetzen (vor Production):
1. ✅ Path Traversal Prevention (#1)
2. ✅ SQL Injection Protection (#2)
3. ✅ Session Fixation Prevention (#3)
4. ✅ Admin Endpoint Protection (#4)
5. ✅ Rate Limiting (#5)
6. ✅ File Upload Validation (#6)
7. ✅ Error Message Sanitization (#7)

### 📋 Vor Launch umsetzen:
8. CSRF Protection (#8)
9. Session Security hardening (#9)
10. IDOR Prevention (#11)
11. Input Sanitization (#17)
12. Password Policy strengthening (#18)
13. User Enumeration Protection (#19)

### 📈 Nach Launch / Monitoring:
14. Security Logging (#15)
15. Encryption Key Management (#14)
16. Database Backups (#22)

### 🔄 Kontinuierlich:
- Dependency Updates (`npm audit`)
- Penetration Testing
- Security Headers Review
- Access Log Analysis

---

## Deployment Checklist

```bash
# Environment Variables (Required!)
export NODE_ENV=production
export AUTH_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export ADMIN_EMAIL=admin@example.com
export ADMIN_PASSWORD='SecurePassword123!@#'

# File Permissions
chmod 700 data/
chmod 600 data/auth.sqlite
chmod 600 data/auth-key.txt

# Dependencies
npm audit fix
npm install express-rate-limit file-type dompurify jsdom

# Firewall
# Nur Port 443 (HTTPS) öffentlich
# Port 3000 nur intern / via Reverse Proxy
```

---

**WICHTIG:** Diese Anwendung ist aktuell **NICHT production-ready**. Alle kritischen (🔴) und hochpriorisierten (🟠) Schwachstellen MÜSSEN vor dem Launch behoben werden.
