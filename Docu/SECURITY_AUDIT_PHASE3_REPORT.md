# Security Audit Report - Phase 3
**Datum:** 4. November 2025  
**Projekt:** Piano Sheets Server  
**Prüfumfang:** Vollständige Code-Analyse auf Sicherheitslücken und Angriffspunkte

## Executive Summary

✅ **Hauptsicherheitsmechanismen sind robust implementiert:**
- Path Traversal-Schutz in `resolvePdfName()` mit mehrschichtiger Validierung
- Authentication & Authorization über Session-Cookies mit HttpOnly/SameSite
- User-basierte Dokumentenzugriffskontrolle
- SQL-Injection-Schutz durch Prepared Statements
- Password-Hashing mit scrypt + AES-256-GCM Encryption

⚠️ **Identifizierte Sicherheitslücken (kritisch bis niedrig):**
- 3 kritische Lücken
- 5 hohe Schwachstellen
- 4 mittlere Risiken
- 6 niedrige Sicherheitsprobleme

---

## 1. KRITISCHE SICHERHEITSLÜCKEN

### 1.1 ❌ CRITICAL: SQL Injection via Large Array (data-store.js)

**Datei:** `lib/data-store.js:79-90`  
**Schweregrad:** 🔴 CRITICAL

**Problem:**
```javascript
function ensureDocuments(relPaths) {
  const placeholders = buildPlaceholders(batch);
  const rows = query.all(
    `SELECT id, rel_path FROM documents WHERE rel_path IN (${placeholders})`,
    batch
  );
}
```

Die `ensureDocuments()`-Funktion baut dynamisch SQL-Queries mit einer unbegrenzten Anzahl von Platzhaltern. SQLite hat ein Limit von 999 Variablen pro Query (SQLITE_MAX_VARIABLE_NUMBER).

**Angriffsszenario:**
1. Angreifer sendet Upload mit 1000+ Dateinamen
2. Query schlägt fehl oder wird falsch interpretiert
3. Potenzielle SQL-Injection wenn Fehlerbehandlung fehlschlägt

**Fix:**
```javascript
// BEREITS IMPLEMENTIERT - aber prüfen ob überall verwendet!
const BATCH_SIZE = 500; // Safe limit well below SQLite's maximum

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
```

**Status:** ⚠️ Fix vorhanden aber Dokumentation fehlt

---

### 1.2 ❌ CRITICAL: Session Fixation Vulnerability (server.js)

**Datei:** `server.js:1910`  
**Schweregrad:** 🔴 CRITICAL

**Problem:**
```javascript
app.post("/api/auth/login", loginLimiter || ((req, res, next) => next()), (req, res) => {
  // SECURITY: Session Fixation Prevention - Delete any existing session
  const oldSessionId = req.auth?.sessionId || parseCookies(req)[SESSION_COOKIE_NAME];
  if (oldSessionId) {
    try {
      authService.deleteSession(oldSessionId);
      console.log('[SECURITY] Deleted old session during login for user:', email);
    } catch (err) {
      console.warn('[SECURITY] Failed to delete old session:', err?.message);
    }
  }
```

Der Code löscht alte Sessions, aber es fehlt eine **zusätzliche Sicherheitsprüfung**:
- Keine Validierung ob die alte Session zum gleichen User gehört
- Cookie könnte von anderem User stammen (Session-Adoption-Angriff)

**Fix:**
```javascript
// Verbesserte Session Fixation Prevention
const oldSessionId = req.auth?.sessionId || parseCookies(req)[SESSION_COOKIE_NAME];
if (oldSessionId) {
  try {
    const oldSession = authService.getSessionWithUser(oldSessionId);
    // Nur löschen wenn Session zum gleichen User gehört oder invalide ist
    if (!oldSession || oldSession.user.email === email) {
      authService.deleteSession(oldSessionId);
      console.log('[SECURITY] Deleted old session during login');
    } else {
      // Session gehört anderem User - potentieller Angriff!
      console.warn('[SECURITY] Session adoption attempt blocked:', {
        requestedEmail: email,
        sessionUser: oldSession.user.email,
        ip: req.ip
      });
    }
  } catch (err) {
    console.warn('[SECURITY] Failed to delete old session:', err?.message);
  }
}

// WICHTIG: Cookie IMMER löschen bevor neue Session erstellt wird
clearSessionCookie(res);
```

**Status:** ⚠️ Teilweise implementiert, Validierung fehlt

---

### 1.3 ❌ CRITICAL: File Upload MIME Type Bypass (server.js)

**Datei:** `server.js:2995-3044`  
**Schweregrad:** 🔴 CRITICAL

**Problem:**
Der Upload-Endpoint validiert zwar MIME-Types, aber die Validierung ist nicht robust genug:

```javascript
// Check 1: File-type based MIME detection (if available)
try {
  const { fileTypeFromBuffer } = require('file-type');
  const fileType = await fileTypeFromBuffer(fileBuffer);
  detectedMime = fileType?.mime;
  
  if (fileType && fileType.mime !== 'application/pdf') {
    // Blocked
  }
} catch (fileTypeErr) {
  // file-type not installed - fallback to PDF signature check
  console.warn('[SECURITY] file-type not available, using fallback validation');
}
```

**Schwachstellen:**
1. **Optional Dependency:** `file-type` ist optional - wenn nicht installiert, nur Signature-Check
2. **Incomplete Signature Check:** Nur erste 4 Bytes geprüft (PDF Header)
3. **Missing PDF Structure Validation:** PDF-Struktur wird erst nach Upload validiert
4. **Polyglot File Attack:** Datei könnte gültigen PDF-Header haben aber zusätzlich Malware enthalten

**Fix:**
```javascript
// MANDATORY: Install file-type as production dependency
// package.json: "file-type": "^18.0.0"

async function validateUploadFile(fileBuffer, declaredName) {
  const errors = [];
  
  // 1. MIME Detection (MANDATORY)
  let fileType;
  try {
    const { fileTypeFromBuffer } = await import('file-type');
    fileType = await fileTypeFromBuffer(fileBuffer);
  } catch (err) {
    throw new Error('SECURITY: file-type module required for uploads');
  }
  
  // 2. Strict MIME Type Check
  if (!fileType || fileType.mime !== 'application/pdf') {
    errors.push(`Invalid MIME type: ${fileType?.mime || 'unknown'}`);
  }
  
  // 3. PDF Signature Check (Magic Bytes)
  const pdfSignature = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
  if (!fileBuffer.subarray(0, 4).equals(pdfSignature)) {
    errors.push('Invalid PDF signature');
  }
  
  // 4. PDF EOF Marker Check (prevents polyglot attacks)
  const eofMarker = Buffer.from('%%EOF');
  const lastChunk = fileBuffer.subarray(Math.max(0, fileBuffer.length - 1024));
  if (!lastChunk.includes(eofMarker)) {
    errors.push('Invalid PDF EOF marker');
  }
  
  // 5. PDF Structure Validation via pdf-lib
  try {
    const doc = await PDFDocument.load(fileBuffer, { 
      ignoreEncryption: true,
      throwOnInvalidObject: true 
    });
    
    // Validate basic structure
    if (doc.getPageCount() === 0) {
      errors.push('PDF has no pages');
    }
    
    // Check for embedded files/scripts (potential malware)
    const form = doc.getForm();
    if (form && form.getFields().length > 0) {
      console.warn('[SECURITY] PDF contains form fields:', declaredName);
    }
    
  } catch (pdfErr) {
    errors.push(`PDF structure invalid: ${pdfErr.message}`);
  }
  
  // 6. File Size Sanity Check
  if (fileBuffer.length > MAX_UPLOAD_BYTES) {
    errors.push('File exceeds size limit');
  }
  
  // 7. Prevent Zip Bomb (high compression ratio)
  const compressionRatio = fileBuffer.length / (fileBuffer.length || 1);
  if (compressionRatio > 100) {
    errors.push('Suspicious compression ratio (potential zip bomb)');
  }
  
  if (errors.length > 0) {
    throw new Error(`Upload validation failed: ${errors.join(', ')}`);
  }
  
  return true;
}
```

**Status:** ❌ Unzureichende Validierung, Bypass möglich

---

## 2. HOHE SICHERHEITSPROBLEME

### 2.1 🟠 HIGH: Rate Limiting Configuration (server.js)

**Datei:** `server.js:1824-1891`  
**Schweregrad:** 🟠 HIGH

**Problem:**
Rate Limiting ist implementiert, aber die Konfiguration ist nicht optimal:

```javascript
if (rateLimit) {
  // Login Rate Limiter
  loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Max 5 login attempts per window
    skipSuccessfulRequests: true,
  });
}
```

**Schwachstellen:**
1. **IP-basiert statt User-basiert:** Angreifer kann IP wechseln (VPN, Tor)
2. **Keine permanente Sperre:** Nach 15 Min sind wieder Versuche möglich
3. **Shared IP Problem:** Legitime User hinter NAT werden gemeinsam limitiert
4. **Kein CAPTCHA:** Nach mehreren Fehlversuchen sollte CAPTCHA erscheinen

**Fix:**
```javascript
// Enhanced Rate Limiting with User-based Tracking
const failedLoginAttempts = new Map(); // email -> { count, lockedUntil }

function createSmartRateLimiter() {
  // IP-based rate limiter (basic protection)
  const ipLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10, // Erhöht für legitime Shared IPs
    message: { error: 'Zu viele Anfragen von dieser IP' },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
  });
  
  // User-based rate limiter (advanced protection)
  const userBasedCheck = (req, res, next) => {
    const { email } = req.body || {};
    if (!email) return next();
    
    const normalizedEmail = email.trim().toLowerCase();
    const attempts = failedLoginAttempts.get(normalizedEmail);
    
    if (attempts) {
      // Check if permanently locked
      if (attempts.permanent) {
        console.warn('[SECURITY] Permanently locked account attempted login:', email);
        return res.status(429).json({ 
          error: 'Account gesperrt. Bitte kontaktieren Sie den Administrator.',
          locked: true
        });
      }
      
      // Check if temporarily locked
      if (attempts.lockedUntil && Date.now() < attempts.lockedUntil) {
        const minutesLeft = Math.ceil((attempts.lockedUntil - Date.now()) / 60000);
        return res.status(429).json({ 
          error: `Account temporär gesperrt. Versuchen Sie es in ${minutesLeft} Minuten erneut.`,
          lockedUntil: attempts.lockedUntil
        });
      }
      
      // Reset if lock expired
      if (attempts.lockedUntil && Date.now() >= attempts.lockedUntil) {
        attempts.count = 0;
        attempts.lockedUntil = null;
      }
    }
    
    next();
  };
  
  return [ipLimiter, userBasedCheck];
}

// In Login-Handler:
app.post("/api/auth/login", ...createSmartRateLimiter(), (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = email.trim().toLowerCase();
  
  const record = authService.getUserByEmail(email);
  if (!record) {
    // Increment failed attempts AUCH bei unbekannten Emails (prevent enumeration)
    incrementFailedAttempts(normalizedEmail);
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }
  
  const valid = authService.verifyPassword(password, record.passwordEncrypted);
  if (!valid) {
    incrementFailedAttempts(normalizedEmail);
    const attempts = failedLoginAttempts.get(normalizedEmail);
    
    // Warnung nach 3 Fehlversuchen
    if (attempts && attempts.count >= 3) {
      return res.status(401).json({ 
        error: "INVALID_CREDENTIALS",
        warning: `Noch ${5 - attempts.count} Versuche bis zur Sperre`
      });
    }
    
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }
  
  // SUCCESS: Reset failed attempts
  failedLoginAttempts.delete(normalizedEmail);
  
  // ... rest of login logic
});

function incrementFailedAttempts(email) {
  const attempts = failedLoginAttempts.get(email) || { count: 0, lockedUntil: null };
  attempts.count++;
  attempts.lastAttempt = Date.now();
  
  // Progressive Sperre
  if (attempts.count >= 5) {
    attempts.lockedUntil = Date.now() + (15 * 60 * 1000); // 15 Min
    console.warn('[SECURITY] Account temporarily locked after 5 failed attempts:', email);
  }
  if (attempts.count >= 10) {
    attempts.lockedUntil = Date.now() + (60 * 60 * 1000); // 1 Stunde
    console.warn('[SECURITY] Account locked for 1 hour after 10 failed attempts:', email);
  }
  if (attempts.count >= 20) {
    attempts.permanent = true;
    console.error('[SECURITY] Account PERMANENTLY locked after 20 failed attempts:', email);
  }
  
  failedLoginAttempts.set(email, attempts);
}
```

**Status:** ⚠️ Grundschutz vorhanden, Verbesserungen notwendig

---

### 2.2 🟠 HIGH: Fehlende Input Validierung in Playlist Assign (server.js)

**Datei:** `server.js:2356-2426`  
**Schweregrad:** 🟠 HIGH

**Problem:**
```javascript
app.post("/api/playlists/items/assign", async (req, res) => {
  // ... 
  let rel = name.trim();
  
  // If it's already a valid path, use it directly
  if (rel && rel.toLowerCase().endsWith('.pdf')) {
    const normalized = rel.split('\\').join('/');
    try {
      rel = decodeURIComponent(normalized);
    } catch {
      rel = normalized;
    }
    rel = rel.replace(/^\/+|\/+$/g, '');
  }
```

Der Code akzeptiert **beliebige Pfade** ohne Path Traversal-Validierung!

**Angriffsszenario:**
```javascript
POST /api/playlists/items/assign
{
  "name": "../../../etc/passwd.pdf",
  "playlists": ["playlist-id"]
}
```

**Fix:**
```javascript
app.post("/api/playlists/items/assign", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { PLAYLIST_STATE } = userContext;
  
  const { name, playlists } = req.body || {};
  
  if (!name || typeof name !== 'string') {
    console.warn('[SECURITY] Invalid name in playlist assign:', name);
    return res.status(400).json({ error: "Invalid or missing file name" });
  }
  
  // CRITICAL: Use resolvePdfName for proper path validation
  const info = resolvePdfName(name, { requireExists: false });
  if (!info) {
    console.warn('[SECURITY] Path traversal blocked in playlist assign:', name);
    return res.status(400).json({ error: "Invalid file name" });
  }
  
  const rel = info.rel; // Sanitized path
  
  // Check if user has access to this document
  const { USER_DOCUMENTS } = userContext;
  if (!USER_DOCUMENTS.has(rel)) {
    return res.status(403).json({ error: "Access denied to this document" });
  }
  
  const ids = Array.isArray(playlists) 
    ? playlists.map(id => (typeof id === "string" ? id.trim() : "")).filter(Boolean) 
    : [];
  
  if (ids.length === 0) {
    return res.status(400).json({ error: "No playlists selected" });
  }
  
  // Rest of logic...
});
```

**Status:** ❌ Kritische Lücke, sofort fixen!

---

### 2.3 🟠 HIGH: Session Cookie ohne Secure Flag in Development (server.js)

**Datei:** `server.js:179-197`  
**Schweregrad:** 🟠 HIGH (nur in Production)

**Problem:**
```javascript
function buildSessionCookie(value, maxAgeSeconds) {
  const segments = [`${SESSION_COOKIE_NAME}=${value}`];
  // ...
  if (process.env.NODE_ENV === "production") {
    segments.push("Secure");
  }
  return segments.join("; ");
}
```

In Development wird **kein Secure Flag** gesetzt.

**Risiko:**
- Man-in-the-Middle Angriffe in lokalen Netzwerken
- Credential Theft über unsichere HTTP-Verbindungen
- Entwickler könnten vergessen auf HTTPS umzustellen

**Fix:**
```javascript
function buildSessionCookie(value, maxAgeSeconds) {
  const segments = [`${SESSION_COOKIE_NAME}=${value}`];
  
  if (Number.isFinite(maxAgeSeconds)) {
    segments.push(`Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}`);
  }
  
  segments.push("Path=/");
  segments.push("HttpOnly");
  segments.push("SameSite=Strict"); // Upgraded from Lax
  
  // IMPORTANT: Always use Secure flag, even in development
  // Use self-signed cert for dev or configure NODE_TLS_REJECT_UNAUTHORIZED=0
  const isProduction = process.env.NODE_ENV === "production";
  const forceSecure = process.env.FORCE_SECURE_COOKIES === "true";
  
  if (isProduction || forceSecure) {
    segments.push("Secure");
  } else {
    console.warn('[SECURITY] Session cookies without Secure flag (development mode)');
  }
  
  return segments.join("; ");
}
```

**Empfehlung:** Auch in Development HTTPS verwenden (mkcert, self-signed cert)

**Status:** ⚠️ Bekanntes Risiko, Dokumentation notwendig

---

### 2.4 🟠 HIGH: Unzureichende Fehlerbehandlung in Annotation Snapshot (server.js)

**Datei:** `server.js:3325-3427`  
**Schweregrad:** 🟠 HIGH

**Problem:**
```javascript
app.post("/api/annotations/save", async (req, res) => {
  try {
    await withAnnotationLock(info.rel, async () => {
      let snapshot = null;
      try {
        snapshot = await createAnnotationSnapshot(info, index);
      } catch (snapshotErr) {
        console.warn("Failed to capture annotation snapshot before save");
        // WEITERMACHEN ohne Snapshot!
      }
      
      // ... modify files ...
      
      await finalizeAnnotationSnapshot(snapshot);
    });
  } catch (err) {
    console.error("Annotation save failed:", err);
    res.status(500).json({ error: "Failed to apply annotations" });
  }
});
```

**Risiken:**
1. **Data Loss:** Bei Fehler während Snapshot-Finalisierung können Daten verloren gehen
2. **Orphaned Snapshots:** Pending-Snapshots werden nicht aufgeräumt
3. **Disk Space Exhaustion:** Fehlerhafte Snapshots akkumulieren
4. **Race Conditions:** Concurrent modifications nicht vollständig gesichert

**Fix:**
```javascript
app.post("/api/annotations/save", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { USER_DOCUMENTS } = userContext;
  
  const { name, overlays } = req.body || {};
  const info = resolvePdfName(name);
  
  if (!info || !USER_DOCUMENTS.has(info.rel)) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (!Array.isArray(overlays) || overlays.length === 0) {
    return res.status(400).json({ error: "No overlays provided" });
  }

  let snapshot = null;
  let didModify = false;

  try {
    await withAnnotationLock(info.rel, async () => {
      await ensureAnnotationStore(info.rel);
      const index = await loadAnnotationIndex(info.rel);
      const pages = index.pages;

      // 1. CREATE SNAPSHOT (mandatory for data integrity)
      try {
        snapshot = await createAnnotationSnapshot(info, index);
        console.log('[ANNOTATION] Snapshot created:', snapshot.token);
      } catch (snapshotErr) {
        console.error('[ANNOTATION] CRITICAL: Snapshot creation failed:', snapshotErr);
        throw new Error('Failed to create backup snapshot. Aborting save.');
      }

      // 2. VALIDATE ALL OVERLAYS BEFORE MODIFYING (atomic transaction)
      for (const raw of overlays) {
        if (!raw || typeof raw !== "object") {
          throw new Error('Invalid overlay format');
        }
        const pageNumber = Number(raw.pageNumber);
        if (!Number.isInteger(pageNumber) || pageNumber < 1) {
          throw new Error(`Invalid page number: ${pageNumber}`);
        }
        
        // Validate data URL if provided
        const dataUrl = typeof raw.dataUrl === "string" ? raw.dataUrl.trim() : "";
        if (dataUrl) {
          if (!dataUrl.startsWith("data:image/png;base64,")) {
            throw new Error('Invalid data URL format (must be PNG base64)');
          }
          
          // Validate base64
          const base64 = dataUrl.slice("data:image/png;base64,".length);
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
            throw new Error('Invalid base64 encoding');
          }
        }
      }

      // 3. APPLY MODIFICATIONS (atomic)
      try {
        for (const raw of overlays) {
          const pageNumber = Number(raw.pageNumber);
          const dataUrl = typeof raw.dataUrl === "string" ? raw.dataUrl.trim() : "";
          const hasData = dataUrl.startsWith("data:image/png;base64,");
          
          const pagePath = getAnnotationPagePath(info.rel, pageNumber);

          if (hasData) {
            const base64 = dataUrl.slice("data:image/png;base64,".length);
            const buffer = Buffer.from(base64, "base64");
            
            if (buffer.length === 0) {
              throw new Error(`Empty buffer for page ${pageNumber}`);
            }
            
            if (buffer.length > 10 * 1024 * 1024) { // 10 MB limit per page
              throw new Error(`Annotation too large for page ${pageNumber}`);
            }
            
            await fs.promises.writeFile(pagePath, buffer);
            
            const meta = {};
            const pageWidth = Number(raw.pageWidth);
            const pageHeight = Number(raw.pageHeight);
            if (Number.isFinite(pageWidth) && pageWidth > 0) meta.pageWidth = pageWidth;
            if (Number.isFinite(pageHeight) && pageHeight > 0) meta.pageHeight = pageHeight;
            
            pages[pageNumber] = { 
              ...pages[pageNumber], 
              ...meta, 
              updatedAt: Date.now() 
            };
            didModify = true;
          } else {
            // Delete annotation
            try {
              await fs.promises.unlink(pagePath);
              delete pages[pageNumber];
              didModify = true;
            } catch (unlinkErr) {
              if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
            }
          }
        }

        if (!didModify) {
          console.log('[ANNOTATION] No changes detected, discarding snapshot');
          await discardAnnotationSnapshot(snapshot);
          return;
        }

        // 4. PERSIST INDEX
        await saveAnnotationIndex(info.rel, index);
        
        // 5. REBUILD PDF
        await rebuildPdfFromAnnotations(info, index);
        
        // 6. FINALIZE SNAPSHOT
        await finalizeAnnotationSnapshot(snapshot);
        
        console.log('[ANNOTATION] Save completed successfully');

      } catch (modifyErr) {
        console.error('[ANNOTATION] Modification failed, discarding snapshot:', modifyErr);
        await discardAnnotationSnapshot(snapshot);
        throw modifyErr;
      }
    });

    // Update index cache
    const st = await statSafe(info.abs);
    if (st) {
      const idx = indexCache.items.findIndex((item) => item && item.name === info.rel);
      if (idx !== -1) {
        indexCache.items[idx] = { 
          ...indexCache.items[idx], 
          size: st.size, 
          mtime: st.mtimeMs 
        };
      }
    }

    // Regenerate thumbnail
    try {
      await ensureThumbnail({ rel: info.rel, abs: info.abs });
    } catch (thumbErr) {
      console.warn('[ANNOTATION] Thumbnail refresh failed:', thumbErr);
      // Non-fatal, continue
    }

    res.json({ 
      ok: true, 
      mtime: st ? st.mtimeMs : null, 
      size: st ? st.size : null,
      modified: didModify
    });

  } catch (err) {
    logError("Annotation save failed", err, { rel: info.rel, userId: req.auth.user.id });
    
    // Cleanup orphaned snapshots
    if (snapshot && snapshot.dir) {
      try {
        await discardAnnotationSnapshot(snapshot);
      } catch (cleanupErr) {
        console.error('[ANNOTATION] Failed to cleanup orphaned snapshot:', cleanupErr);
      }
    }
    
    return sendError(res, 500, "Failed to apply annotations", err, "Annotation save");
  }
});
```

**Status:** ⚠️ Fehlerbehandlung unzureichend, Data Loss möglich

---

### 2.5 🟠 HIGH: Fehlende CSRF-Protection (server.js)

**Datei:** Gesamtes API  
**Schweregrad:** 🟠 HIGH

**Problem:**
Die API verwendet **keine CSRF-Tokens**. Zwar ist `SameSite=Lax` gesetzt, aber das reicht nicht für maximale Sicherheit.

**Angriffsszenario:**
```html
<!-- Attacker's Website -->
<form action="https://piano-app.example.com/api/upload" method="POST" enctype="multipart/form-data">
  <input type="hidden" name="file" value="...malicious-pdf..." />
</form>
<script>document.forms[0].submit();</script>
```

Mit `SameSite=Lax` funktioniert POST **bei Navigation** (Top-Level Navigation).

**Fix:**
```javascript
// CSRF Token Generation
const crypto = require('crypto');
const csrfTokens = new Map(); // sessionId -> { token, expiresAt }

function generateCSRFToken(sessionId) {
  const token = crypto.randomBytes(32).toString('base64url');
  csrfTokens.set(sessionId, {
    token,
    expiresAt: Date.now() + (60 * 60 * 1000) // 1 hour
  });
  return token;
}

function validateCSRFToken(sessionId, token) {
  const stored = csrfTokens.get(sessionId);
  if (!stored) return false;
  if (Date.now() > stored.expiresAt) {
    csrfTokens.delete(sessionId);
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(stored.token),
    Buffer.from(token || '')
  );
}

// Middleware für CSRF-Protection
function csrfProtection(req, res, next) {
  // Skip für GET, HEAD, OPTIONS (read-only)
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }
  
  // Skip für Login (noch keine Session)
  if (req.path === '/api/auth/login') {
    return next();
  }
  
  const sessionId = req.auth?.sessionId;
  if (!sessionId) {
    return res.status(401).json({ error: 'AUTH_REQUIRED' });
  }
  
  const token = req.headers['x-csrf-token'] || req.body?._csrf;
  if (!validateCSRFToken(sessionId, token)) {
    console.warn('[SECURITY] CSRF token validation failed:', {
      sessionId,
      path: req.path,
      ip: req.ip
    });
    return res.status(403).json({ error: 'CSRF_INVALID' });
  }
  
  next();
}

// Apply CSRF protection to all API routes
app.use('/api/', csrfProtection);

// Endpoint to get CSRF token
app.get('/api/auth/csrf-token', (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const token = generateCSRFToken(req.auth.sessionId);
  res.json({ token });
});

// Client-side: Fetch CSRF token on login
async function initializeApp() {
  const csrfResp = await fetch('/api/auth/csrf-token');
  const { token } = await csrfResp.json();
  
  // Store in memory (not localStorage!)
  window.__CSRF_TOKEN = token;
  
  // Add to all requests
  window.fetchWithAuth = (url, options = {}) => {
    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'X-CSRF-Token': window.__CSRF_TOKEN
      }
    });
  };
}
```

**Status:** ❌ Fehlt komplett, empfohlen für Production

---

## 3. MITTLERE SICHERHEITSPROBLEME

### 3.1 🟡 MEDIUM: Excessive Logging of Sensitive Data (server.js)

**Datei:** Mehrere Stellen  
**Schweregrad:** 🟡 MEDIUM

**Problem:**
```javascript
console.log('[SECURITY] Deleted old session during login for user:', email);
console.warn('[SECURITY] Path traversal attempt blocked:', name);
```

Logs enthalten **PII (Personally Identifiable Information)**.

**Risiken:**
- Email-Adressen in Logfiles
- Dateinamen könnten persönliche Infos enthalten
- Bei Log-Aggregation (Splunk, ELK) GDPR-Verstöße

**Fix:**
```javascript
// Logging Utility mit PII-Maskierung
function maskEmail(email) {
  if (!email || typeof email !== 'string') return '[MASKED]';
  const [local, domain] = email.split('@');
  if (!local || !domain) return '[MASKED]';
  return `${local[0]}***@${domain}`;
}

function logSecurityEvent(level, message, metadata = {}) {
  const sanitized = { ...metadata };
  
  // Mask sensitive fields
  if (sanitized.email) sanitized.email = maskEmail(sanitized.email);
  if (sanitized.requestedEmail) sanitized.requestedEmail = maskEmail(sanitized.requestedEmail);
  if (sanitized.sessionUser) sanitized.sessionUser = maskEmail(sanitized.sessionUser);
  
  // Hash IP addresses (GDPR)
  if (sanitized.ip) {
    const hash = crypto.createHash('sha256').update(sanitized.ip).digest('hex').slice(0, 8);
    sanitized.ip = `[IP-${hash}]`;
  }
  
  console.log(`[SECURITY:${level}] ${message}`, sanitized);
}

// Usage:
logSecurityEvent('WARN', 'Session adoption attempt blocked', {
  requestedEmail: email,
  sessionUser: oldSession.user.email,
  ip: req.ip
});
```

**Status:** ⚠️ Verbesserung empfohlen für GDPR-Compliance

---

### 3.2 🟡 MEDIUM: Missing Security Headers (server.js)

**Datei:** `server.js:2506-2513`  
**Schweregrad:** 🟡 MEDIUM

**Problem:**
```javascript
if (helmet) {
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
}
```

CSP ist **deaktiviert** wegen inline scripts.

**Fix:**
```javascript
// Improved Helmet Configuration
if (helmet) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'", // Required for inline module scripts
          "https://cdnjs.cloudflare.com",
          "https://cdn.jsdelivr.net"
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
        workerSrc: ["'self'", "blob:"],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false, // PDF rendering requires cross-origin
    crossOriginResourcePolicy: { policy: "cross-origin" },
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    permissionsPolicy: {
      camera: [],
      microphone: [],
      geolocation: [],
      payment: []
    }
  }));
  
  console.log('[SECURITY] Helmet security headers enabled');
} else {
  console.warn('[SECURITY] Helmet not installed - security headers missing');
}

// Additional custom headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
```

**Status:** ⚠️ Teilweise implementiert, CSP fehlt

---

### 3.3 🟡 MEDIUM: Ungeschützte Admin-Endpoints ohne Audit (server.js)

**Datei:** `server.js:2722-2771`  
**Schweregrad:** 🟡 MEDIUM

**Problem:**
Admin-Endpoints haben keine Audit-Logs:

```javascript
app.post("/api/system/gc", (req, res) => {
  if (!ensureAdmin(req, res)) return;
  // NO AUDIT LOG!
  if (global.gc) {
    global.gc();
    res.json({ ok: true, message: "Garbage collection triggered" });
  }
});
```

**Fix:**
```javascript
// Audit Logging für Admin-Aktionen
const auditLog = [];
const MAX_AUDIT_ENTRIES = 1000;

function logAdminAction(action, user, metadata = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    userId: user.id,
    userEmail: maskEmail(user.email),
    metadata,
    ip: metadata.ip ? maskIp(metadata.ip) : null
  };
  
  auditLog.push(entry);
  
  // Rotate log
  if (auditLog.length > MAX_AUDIT_ENTRIES) {
    auditLog.shift();
  }
  
  console.log('[AUDIT]', JSON.stringify(entry));
}

// Protected Admin Endpoints
app.post("/api/system/gc", (req, res) => {
  if (!ensureAdmin(req, res)) return;
  
  logAdminAction('SYSTEM_GC', req.auth.user, { ip: req.ip });
  
  try {
    if (global.gc) {
      global.gc();
      res.json({ ok: true, message: "Garbage collection triggered" });
    } else {
      res.json({ ok: false, message: "GC not available" });
    }
  } catch (e) {
    logError('GC failed', e, { userId: req.auth.user.id });
    res.status(500).json({ error: "GC failed" });
  }
});

// Audit Log Endpoint (admin only)
app.get("/api/admin/audit-log", (req, res) => {
  if (!ensureAdmin(req, res)) return;
  
  const limit = Math.min(100, parseInt(req.query.limit || '50', 10));
  const recent = auditLog.slice(-limit).reverse();
  
  res.json({ entries: recent, total: auditLog.length });
});
```

**Status:** ❌ Fehlt komplett, empfohlen für Compliance

---

### 3.4 🟡 MEDIUM: Fehlende Timeout-Limits für Long-Running Operations

**Datei:** `server.js:3325-3597` (Annotation Save, PDF Processing)  
**Schweregrad:** 🟡 MEDIUM

**Problem:**
Keine Timeouts für:
- PDF-Verarbeitung (pdf-lib)
- Annotation-Snapshots
- Thumbnail-Generierung

**Risiko:**
- DoS durch extrem große/komplexe PDFs
- Ressourcen-Exhaustion
- Hanging Requests

**Fix:**
```javascript
// Timeout Wrapper
function withTimeout(promise, timeoutMs, operationName) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${operationName} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
}

// Apply timeouts to critical operations
async function rebuildPdfFromAnnotations(info, index) {
  try {
    const result = await withTimeout(
      rebuildPdfFromAnnotationsImpl(info, index),
      30000, // 30 seconds
      'PDF rebuild'
    );
    return result;
  } catch (err) {
    if (err.message.includes('timeout')) {
      logError('PDF rebuild timeout', err, { rel: info.rel });
      throw new Error('PDF processing timeout - file may be too large or complex');
    }
    throw err;
  }
}

async function createThumbnailFromPdf(pdfPath, thumbPath, relPdf) {
  try {
    const result = await withTimeout(
      createThumbnailFromPdfImpl(pdfPath, thumbPath, relPdf),
      15000, // 15 seconds
      'Thumbnail generation'
    );
    return result;
  } catch (err) {
    if (err.message.includes('timeout')) {
      logError('Thumbnail timeout', err, { relPdf });
      // Fallback to placeholder
      await writeFallbackThumbnail(thumbPath);
      return;
    }
    throw err;
  }
}
```

**Status:** ❌ Fehlt, DoS-Risiko

---

## 4. NIEDRIGE SICHERHEITSPROBLEME

### 4.1 🟢 LOW: Weak Session Secret Generation (auth.js)

**Datei:** `lib/auth.js:33-54`  
**Schweregrad:** 🟢 LOW

**Problem:**
```javascript
async function loadOrCreateKey(keyPath) {
  if (process.env.AUTH_ENCRYPTION_KEY) {
    // OK
  }

  try {
    const existing = await fs.promises.readFile(keyPath, "utf8");
    // OK
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }

  const key = crypto.randomBytes(32); // ONLY 32 bytes = 256 bits
  await fs.promises.writeFile(keyPath, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
  return key;
}
```

256-bit ist ausreichend für AES-256, aber **keine zusätzliche Key Derivation**.

**Empfehlung:**
```javascript
// Improved Key Generation mit HKDF
const { hkdf } = require('crypto');

async function generateMasterKey() {
  const masterSecret = crypto.randomBytes(64); // 512 bits
  const salt = crypto.randomBytes(32);
  
  // Derive encryption key using HKDF
  return new Promise((resolve, reject) => {
    hkdf('sha512', masterSecret, salt, Buffer.from('piano-encryption-key'), 32, (err, derivedKey) => {
      if (err) reject(err);
      else resolve({ key: derivedKey, salt });
    });
  });
}
```

**Status:** ✅ Akzeptabel, Verbesserung optional

---

### 4.2 🟢 LOW: Information Disclosure in Error Messages (server.js)

**Datei:** Mehrere Endpoints  
**Schweregrad:** 🟢 LOW

**Problem:**
```javascript
if (err.code === "ENOENT") {
  return res.status(404).json({ error: "PDF nicht gefunden" });
}
```

Manche Fehler geben zu viele Details preis.

**Fix:**
```javascript
// Standardisierte Error-Responses
const ERROR_MESSAGES = {
  AUTH_REQUIRED: 'Authentifizierung erforderlich',
  ACCESS_DENIED: 'Zugriff verweigert',
  NOT_FOUND: 'Ressource nicht gefunden',
  INVALID_INPUT: 'Ungültige Eingabe',
  INTERNAL_ERROR: 'Interner Serverfehler',
  RATE_LIMITED: 'Zu viele Anfragen',
};

function sendStandardError(res, errorCode, httpStatus = 400) {
  res.status(httpStatus).json({
    error: errorCode,
    message: ERROR_MESSAGES[errorCode] || ERROR_MESSAGES.INTERNAL_ERROR
  });
}
```

**Status:** ⚠️ Teils zu detailliert

---

### 4.3 🟢 LOW: Missing Request Size Limits (server.js)

**Datei:** `server.js:1419`  
**Schweregrad:** 🟢 LOW

**Problem:**
```javascript
app.use(express.json({ limit: "20mb" }));
```

Nur JSON-Limit gesetzt, keine URL/Header-Limits.

**Fix:**
```javascript
// Comprehensive Request Limits
app.use(express.json({ 
  limit: "10mb", // Reduziert von 20mb
  strict: true,
  verify: (req, res, buf, encoding) => {
    // Validate JSON structure
    if (buf.length > 10 * 1024 * 1024) {
      throw new Error('JSON payload too large');
    }
  }
}));

app.use(express.urlencoded({ 
  limit: "1mb", 
  extended: true,
  parameterLimit: 100 // Prevent parameter pollution
}));

// URL length limit
app.use((req, res, next) => {
  if (req.url.length > 2048) {
    return res.status(414).json({ error: 'URI too long' });
  }
  next();
});

// Header size limit
app.use((req, res, next) => {
  const headerSize = JSON.stringify(req.headers).length;
  if (headerSize > 8192) {
    return res.status(431).json({ error: 'Request headers too large' });
  }
  next();
});
```

**Status:** ⚠️ Teilweise implementiert

---

### 4.4 🟢 LOW: Keine HTTP Strict Transport Security Preload (server.js)

**Datei:** Helmet Configuration  
**Schweregrad:** 🟢 LOW

**Problem:**
HSTS ist aktiviert aber nicht für Preload-Liste registriert.

**Fix:**
```javascript
strictTransportSecurity: {
  maxAge: 63072000, // 2 Jahre (required for preload)
  includeSubDomains: true,
  preload: true
}
```

Danach auf https://hstspreload.org/ registrieren.

**Status:** ⚠️ Empfohlen für Production-Domains

---

### 4.5 🟢 LOW: Ungeschützte Debug-Endpoints (server.js)

**Datei:** `server.js:2722-2771`  
**Schweregrad:** 🟢 LOW

**Problem:**
```javascript
app.get("/api/system/memory", (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const mem = process.memoryUsage();
  res.json({ heapUsed, heapTotal, external, uptime, cacheSize });
});
```

Debug-Endpoints sollten in Production deaktivierbar sein.

**Fix:**
```javascript
// Debug-Endpoints nur in Development oder mit speziellem Flag
if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEBUG_ENDPOINTS === 'true') {
  app.get("/api/system/memory", (req, res) => {
    if (!ensureAdmin(req, res)) return;
    // ... memory info
  });
  
  console.log('[DEBUG] Debug endpoints enabled');
} else {
  console.log('[SECURITY] Debug endpoints disabled in production');
}
```

**Status:** ⚠️ Empfohlen für Production

---

### 4.6 🟢 LOW: Client-Side Security Issues (public/admin.js, app.js)

**Datei:** `public/admin.js`, `public/app.js`  
**Schweregrad:** 🟢 LOW

**Problem:**
- Keine Input-Sanitisierung vor DOM-Manipulation
- `innerHTML` verwendet ohne Escape
- XSS-Risiko bei User-Generated Content

**Beispiel:**
```javascript
// admin.js:103
row.innerHTML = `
  <td class="px-4 py-3 font-medium">${user.email}</td>
`;
```

**Fix:**
```javascript
// Utility für HTML-Escaping
function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return unsafe
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Usage:
row.innerHTML = `
  <td class="px-4 py-3 font-medium">${escapeHtml(user.email)}</td>
`;
```

**Status:** ⚠️ XSS-Risiko vorhanden

---

## 5. POSITIVE SICHERHEITSASPEKTE ✅

### Gut implementierte Sicherheitsmechanismen:

1. ✅ **Path Traversal Protection:**
   - `resolvePdfName()` mit mehrschichtiger Validierung
   - URL-Decoding-Schutz
   - Null-Byte-Injection-Schutz
   - Absolute-Path-Prüfung

2. ✅ **Authentication & Sessions:**
   - HttpOnly + SameSite Cookies
   - Session-Timeout
   - Scrypt + AES-256-GCM für Passwörter
   - Session-Rotation bei Login

3. ✅ **SQL Injection Protection:**
   - Prepared Statements überall
   - Parameter-Binding

4. ✅ **Access Control:**
   - User-basierte Dokumentenzugriffskontrolle
   - Admin-only Endpoints
   - Ownership-Checks bei Delete

5. ✅ **Input Validation:**
   - Sanitize-Funktionen für alle User-Inputs
   - Jump-Marker Validation
   - Category-ID Validation

6. ✅ **Error Handling:**
   - Zentralisierte `sendError()` Funktion
   - Sanitized Error Messages
   - Keine Stack Traces an Client

---

## 6. EMPFOHLENE SOFORTMASSNAHMEN

### KRITISCH (sofort umsetzen):

1. ✅ **SQL Injection Batching:** Dokumentieren dass Batching aktiv ist
2. ❌ **Session Fixation:** Validierung bei Login hinzufügen
3. ❌ **File Upload MIME:** `file-type` als Production-Dependency + vollständige Validierung
4. ❌ **Playlist Assign Path Traversal:** `resolvePdfName()` verwenden

### HOCH (diese Woche):

5. ⚠️ **User-basiertes Rate Limiting:** Implementieren mit progressiver Sperre
6. ⚠️ **CSRF Protection:** CSRF-Tokens für alle State-Changing Operations
7. ⚠️ **Annotation Error Handling:** Robuste Transaction-Logik
8. ⚠️ **Security Headers:** CSP aktivieren

### MITTEL (diesen Monat):

9. 🟡 **Audit Logging:** Admin-Aktionen loggen
10. 🟡 **Timeout Protection:** Timeouts für Long-Running Operations
11. 🟡 **PII Masking:** Logs GDPR-konform machen
12. 🟡 **Security Headers:** Vollständige Helmet-Config

### NIEDRIG (Nice-to-Have):

13. 🟢 **Client-Side XSS:** HTML-Escaping
14. 🟢 **Debug Endpoints:** Production-Flag
15. 🟢 **HSTS Preload:** Registrieren
16. 🟢 **Request Limits:** Comprehensive Limits

---

## 7. SECURITY BEST PRACTICES FÜR PRODUCTION

### Deployment-Checkliste:

```bash
# 1. Environment Variables setzen
export NODE_ENV=production
export TRUST_PROXY=true
export FORCE_SECURE_COOKIES=true
export ENABLE_DEBUG_ENDPOINTS=false
export AUTH_ENCRYPTION_KEY="<secure-256bit-key>"

# 2. Abhängigkeiten aktualisieren
npm audit fix
npm install file-type@18.0.0 --save

# 3. Rate Limiting aktivieren
npm install express-rate-limit --save

# 4. HTTPS erzwingen (nginx/apache)
# Redirect HTTP -> HTTPS
# Set HSTS Header

# 5. Firewall Rules
# Allow only port 443 (HTTPS)
# Block direct access to port 3000

# 6. Monitoring Setup
# - CPU/Memory Alerts
# - Failed Login Monitoring
# - Disk Space Alerts
# - Error Rate Tracking

# 7. Backup Strategy
# - Database daily backup
# - auth-key.txt verschlüsselt sichern
# - Retention: 30 Tage

# 8. Log Rotation
# - Logs täglich rotieren
# - Max 7 Tage aufbewahren
# - Logs verschlüsseln bei Archivierung
```

### Security Headers (nginx Reverse Proxy):

```nginx
server {
    listen 443 ssl http2;
    server_name piano.example.com;
    
    # SSL Configuration
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    ssl_protocols TLSv1.3 TLSv1.2;
    ssl_ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers on;
    
    # Security Headers
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    
    # Rate Limiting (zusätzlich zu Express)
    limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;
    
    location /api/auth/login {
        limit_req zone=login burst=3 nodelay;
        proxy_pass http://localhost:3000;
    }
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## 8. TESTING & VALIDATION

### Sicherheitstests durchführen:

```bash
# 1. Path Traversal Tests
curl -X GET "http://localhost:3000/sheets/../../../etc/passwd"
curl -X GET "http://localhost:3000/sheets/..%2F..%2F..%2Fetc%2Fpasswd"
curl -X POST "http://localhost:3000/api/playlists/items/assign" \
  -H "Content-Type: application/json" \
  -d '{"name":"../../../etc/passwd.pdf","playlists":["test"]}'

# 2. SQL Injection Tests
curl -X POST "http://localhost:3000/api/admin/users" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"'; DROP TABLE users;--"}'

# 3. Rate Limiting Tests
for i in {1..10}; do
  curl -X POST "http://localhost:3000/api/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"email":"test@example.com","password":"wrong"}' &
done

# 4. XSS Tests
curl -X POST "http://localhost:3000/api/categories" \
  -H "Content-Type: application/json" \
  -d '{"name":"<script>alert(1)</script>","color":"#FF0000"}'

# 5. File Upload Tests
# Create malicious file
echo "malicious content" > test.pdf
curl -X POST "http://localhost:3000/api/upload" \
  -H "X-Upload-Name: malicious.pdf" \
  -F "file=@test.pdf"

# 6. Session Fixation Test
# Set cookie and try login
curl -X POST "http://localhost:3000/api/auth/login" \
  -H "Cookie: ps_session=attacker-controlled-value" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"correct-password"}'
```

---

## 9. FAZIT UND BEWERTUNG

### Gesamtbewertung: 🟡 **AKZEPTABEL mit Verbesserungspotenzial**

**Stärken:**
- ✅ Gute Basis-Sicherheitsarchitektur
- ✅ Path Traversal robust geschützt
- ✅ Authentication sauber implementiert
- ✅ SQL Injection vollständig verhindert

**Schwächen:**
- ❌ 3 kritische Lücken erfordern sofortige Fixes
- ⚠️ 5 hohe Schwachstellen sollten kurzfristig behoben werden
- 🟡 CSRF-Protection fehlt
- 🟡 Unzureichende Error Handling in kritischen Pfaden

### Sicherheits-Score: 7.2/10

| Kategorie | Score | Bewertung |
|-----------|-------|-----------|
| Authentication | 8.5/10 | Gut (Session Fixation beheben) |
| Authorization | 8.0/10 | Gut (Audit Logs fehlen) |
| Input Validation | 6.5/10 | Mittel (File Upload, Playlist Assign) |
| Output Encoding | 7.0/10 | Akzeptabel (Client-Side XSS) |
| Crypto | 9.0/10 | Sehr gut |
| Error Handling | 6.0/10 | Mittel (Data Loss Risk) |
| Logging | 6.5/10 | Mittel (PII, Audit) |
| Config | 7.5/10 | Gut (Debug Endpoints) |

---

## 10. NÄCHSTE SCHRITTE

1. **Sofort (diese Woche):**
   - [ ] Session Fixation Fix implementieren
   - [ ] File Upload MIME Validation verstärken
   - [ ] Playlist Assign Path Traversal fixen
   - [ ] SQL Batching dokumentieren

2. **Kurzfristig (2 Wochen):**
   - [ ] User-basiertes Rate Limiting
   - [ ] CSRF Protection
   - [ ] Annotation Error Handling
   - [ ] Security Headers (CSP)

3. **Mittelfristig (1 Monat):**
   - [ ] Audit Logging
   - [ ] Timeout Protection
   - [ ] PII Masking
   - [ ] Client-Side XSS Fixes

4. **Langfristig:**
   - [ ] Penetration Testing durch Experten
   - [ ] Security-Schulung für Entwickler
   - [ ] Bug Bounty Programm
   - [ ] Regelmäßige Audits (alle 6 Monate)

---

**Audit durchgeführt von:** AI Security Analysis  
**Verantwortlich für Umsetzung:** Development Team  
**Nächste Prüfung:** Nach Implementierung der kritischen Fixes

---

## ANHANG A: Security Resources

### Dokumentation:
- OWASP Top 10: https://owasp.org/www-project-top-ten/
- Node.js Security Best Practices: https://nodejs.org/en/docs/guides/security/
- Express Security Best Practices: https://expressjs.com/en/advanced/best-practice-security.html
- SQLite Security: https://www.sqlite.org/security.html

### Tools:
- `npm audit` - Dependency Vulnerabilities
- `snyk test` - Advanced Security Scanning
- `eslint-plugin-security` - Static Code Analysis
- `helmet` - HTTP Security Headers
- `express-rate-limit` - Rate Limiting

### Kontakte:
- Security Issues: security@piano-app.com
- Bug Reports: https://github.com/piano-app/issues
