// server.js — Piano Sheets (server-side thumbnail generation for performance)

// Load environment variables from .env file (if exists)
try {
  require('dotenv').config();
  console.log('[CONFIG] Environment variables loaded from .env file');
} catch (err) {
  // dotenv not installed or .env file missing - use system environment variables
  console.log('[CONFIG] Using system environment variables (dotenv not available)');
}

const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const { randomUUID } = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const { PDFDocument } = require("pdf-lib");
const { createAuthService } = require("./lib/auth");
const { createDataStore } = require("./lib/data-store");

// Optional middlewares (used if installed; otherwise skipped)
let helmet = null, morgan = null, compression = null, rateLimit = null;
try { helmet = require("helmet"); } catch {}
try { morgan = require("morgan"); } catch {}
try { compression = require("compression"); } catch {}
try { rateLimit = require("express-rate-limit"); } catch {}

// Try to load PDF processing libraries
let pdfjsLib = null, sharp = null, canvas = null;
try {
  // Use legacy build that exposes CommonJS interface (compatible with Node)
  pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

  if (pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve("pdfjs-dist/legacy/build/pdf.worker.js");
    } catch (workerErr) {
      console.warn("pdf.js worker not found, thumbnails may be slower:", workerErr.message);
      pdfjsLib.GlobalWorkerOptions.workerSrc = undefined;
    }
  }

  console.log("PDF.js legacy build loaded (version:", pdfjsLib?.version || "unknown", ")");
} catch (e) {
  pdfjsLib = null;
  console.warn("pdfjs-dist not available - thumbnails disabled:", e.message);
}

try { 
  sharp = require("sharp"); 
  console.log("Sharp loaded for image optimization");
} catch { 
  console.warn("sharp not available - will use canvas fallback"); 
}

try { 
  canvas = require("canvas"); 
  console.log("Canvas loaded for PDF rendering");
} catch { 
  console.warn("canvas not available - limited thumbnail support"); 
}

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_PATH = process.env.BASE_PATH || ''; // e.g., '/music' for proxy setups

// =============================================================================
// PROXY SUPPORT: Trust proxy headers for reverse proxy setups
// =============================================================================
// Enable if running behind nginx, Apache, npm proxy, Cloudflare, etc.
// This allows Express to correctly read X-Forwarded-* headers
if (process.env.TRUST_PROXY !== 'false') {
  // Parse TRUST_PROXY value correctly
  let trustProxyValue = process.env.TRUST_PROXY || 'loopback';
  
  // Convert string "true" to boolean true
  if (trustProxyValue === 'true') {
    trustProxyValue = true;
  } 
  // Convert string "false" to boolean false
  else if (trustProxyValue === 'false') {
    trustProxyValue = false;
  }
  // Convert numeric strings to numbers (hop count)
  else if (!isNaN(trustProxyValue)) {
    trustProxyValue = parseInt(trustProxyValue, 10);
  }
  // Otherwise keep as string (IP address, subnet, or 'loopback')
  
  app.set('trust proxy', trustProxyValue);
  console.log('[PROXY] Trust proxy enabled:', app.get('trust proxy'));
}

if (BASE_PATH) {
  console.log(`[PROXY] Base path configured: ${BASE_PATH}`);
}

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const SHEETS_DIR = path.join(ROOT, "sheets");
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const LEGACY_PLAYLIST_FILE = path.join(DATA_DIR, "playlist.json");
const PLAYLISTS_FILE = path.join(DATA_DIR, "playlists.json");
const THUMBS_DIR = path.join(DATA_DIR, "thumbnails"); // New: thumbnail cache directory
const ANNOTATIONS_DIR = path.join(DATA_DIR, "annotations");
const MAX_ANNOTATION_VERSIONS = 20;
const CPU_COUNT = Math.max(1, typeof os.cpus === "function" ? os.cpus().length : 1);

const DEFAULT_CATEGORY_COLOR = "#6366F1";
// 1x1 subtle violet JPEG (valid for .jpg extension)
const FALLBACK_THUMB_BUFFER = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEhUTEhIVFRUVFxUXFhUVFxcYFRUVFRUXFxcYHSggGBolGxUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGxAQGy0lICUtNS0tLS0tLy0tLS0tLS0vLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tKy0tLS0tLS0tLf/AABEIAKgBLAMBIgACEQEDEQH/xAAbAAACAgMBAAAAAAAAAAAAAAADBAIFAQAGB//EADYQAAEDAgMFBQcEAgIDAAAAAAEAAgMEEQUSIRMxQVFhBhMicYEykaGxwdHwFCMzUvEkUmLR4fEjM1PSFiRT/8QAGQEBAAMBAQAAAAAAAAAAAAAAAAECAwQA/8QAJxEBAAICAgIBAwQDAAAAAAAAAAECAxEEIRIxQRNRYSJxBRRxkbH/2gAMAwEAAhEDEQA/AO6iIiICIiAiIgIiICIiAiIgIiICIiAiIgIiICIiAiIgIiICIiAiIgI//2Q==",
  "base64"
);

const SESSION_COOKIE_NAME = "ps_session";
const SESSION_RENEW_THRESHOLD_MS = 1000 * 60 * 60 * 24; // 24 hours
const SSE_EVENT_PATHS = ["/api/playlists/events", "/api/playlist/events"];

// =============================================================================
// SECURITY: Centralized error handling and sanitization
// =============================================================================

/**
 * Logs an error securely with full details (for server logs)
 * @param {string} context - Description of where/what failed
 * @param {Error|any} error - The error object
 * @param {Object} metadata - Additional context (userId, file paths, etc.)
 */
function logError(context, error, metadata = {}) {
  const timestamp = new Date().toISOString();
  const errorDetails = {
    timestamp,
    context,
    message: error?.message || String(error),
    stack: error?.stack,
    ...metadata
  };
  
  // Log full error details to console (server-side only)
  console.error(`[ERROR] ${context}:`, errorDetails);
}

/**
 * Sends a sanitized error response to the client (no stack traces, no internal paths)
 * @param {Response} res - Express response object
 * @param {number} statusCode - HTTP status code
 * @param {string} userMessage - Safe message for the user
 * @param {Error|any} error - The original error (for logging only)
 * @param {string} context - Context for logging
 */
function sendError(res, statusCode, userMessage, error = null, context = '') {
  // Log full error server-side
  if (error && context) {
    logError(context, error, { statusCode, userMessage });
  }
  
  // Send sanitized response to client
  res.status(statusCode).json({ 
    error: userMessage,
    // Never include: stack traces, internal paths, raw error objects
  });
}

/**
 * Sanitizes file paths in error messages (removes absolute paths)
 * @param {string} message - Error message that might contain paths
 * @returns {string} - Sanitized message
 */
function sanitizePath(message) {
  if (!message) return message;
  // Remove absolute paths like /Volumes/home/piano/ or C:\Users\...
  return message
    .replace(/[A-Za-z]:\\[^\s]+/g, '[PATH]')
    .replace(/\/[^\s]+\/(sheets|data|public|thumbnails)/g, '/$1')
    .replace(/file:\/\/[^\s]+/g, '[FILE]');
}

function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header) return {};
  return header.split(";").reduce((acc, part) => {
    const [key, ...rest] = part.split("=");
    if (!key) return acc;
    const value = rest.join("=");
    acc[key.trim()] = decodeURIComponent((value || "").trim());
    return acc;
  }, {});
}

function appendSetCookie(res, value) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", value);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", existing.concat(value));
  } else {
    res.setHeader("Set-Cookie", [existing, value]);
  }
}

function buildSessionCookie(value, maxAgeSeconds) {
  const segments = [`${SESSION_COOKIE_NAME}=${value}`];
  if (Number.isFinite(maxAgeSeconds)) {
    segments.push(`Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}`);
  }
  segments.push("Path=/");
  segments.push("HttpOnly");
  segments.push("SameSite=Lax");
  
  // Use SESSION_SECURE from .env, fallback to NODE_ENV check
  const shouldBeSecure = process.env.SESSION_SECURE === 'true' || 
                         (process.env.SESSION_SECURE !== 'false' && process.env.NODE_ENV === 'production');
  
  if (shouldBeSecure) {
    segments.push("Secure");
  }
  
  return segments.join("; ");
}

function setSessionCookie(res, sessionId, expiresAtIso) {
  const expiresMs = new Date(expiresAtIso).getTime() - Date.now();
  const maxAgeSeconds = Math.max(1, Math.floor(expiresMs / 1000));
  appendSetCookie(res, buildSessionCookie(sessionId, maxAgeSeconds));
}

function clearSessionCookie(res) {
  appendSetCookie(res, buildSessionCookie("", 0));
}

function ensureAuthenticated(req, res) {
  if (!authService) {
    res.status(503).json({ error: "Auth service unavailable" });
    return false;
  }
  if (!req.auth || !req.auth.user) {
    res.status(401).json({ error: "AUTH_REQUIRED" });
    return false;
  }
  return true;
}

function ensureAdmin(req, res) {
  if (!ensureAuthenticated(req, res)) return false;
  if (req.auth.user.role !== "admin") {
    res.status(403).json({ error: "ADMIN_REQUIRED" });
    return false;
  }
  return true;
}

function isSoleActiveAdmin(userId) {
  if (!authService) return false;
  const admins = authService.listUsers().filter((user) => user.role === "admin" && user.isActive);
  return admins.length === 1 && admins[0].id === userId;
}

function sanitizeHexColor(input) {
  if (typeof input !== "string") return DEFAULT_CATEGORY_COLOR;
  let color = input.trim();
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color);
  if (!match) return DEFAULT_CATEGORY_COLOR;
  const value = match[1];
  if (value.length === 3) {
    color = `#${value.split("").map((ch) => ch + ch).join("")}`;
  } else {
    color = `#${value}`;
  }
  return color.toUpperCase();
}

function slugifyCategoryId(name, fallback = "cat") {
  const base = (name || "").toString().toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || fallback;
}

function sanitizeCategoryIcon(icon) {
  if (typeof icon !== "string") return "♪";
  const trimmed = icon.trim();
  if (!trimmed) return "♪";
  return trimmed.slice(0, 2);
}

function sanitizeJumpMarkers(input) {
  if (!Array.isArray(input)) return [];

  const clampPercent = (value, fallback) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const bounded = Math.max(0, Math.min(100, num));
    return Math.round(bounded * 1000) / 1000;
  };

  const sanitizePoint = (point, role) => {
    if (!point || typeof point !== "object") return null;
    const page = Number(point.pageNumber);
    if (!Number.isFinite(page) || page < 1) return null;
    const defaults = role === "target" ? { x: 70, y: 25 } : { x: 30, y: 25 };
    return {
      pageNumber: Math.floor(page),
      x: clampPercent(point.x, defaults.x),
      y: clampPercent(point.y, defaults.y),
    };
  };

  const directPairs = [];
  const legacyByTag = new Map();

  input.forEach((marker, idx) => {
    if (!marker || typeof marker !== "object") return;

    if (marker.source || marker.target) {
      const rawSource = marker.source && typeof marker.source === "object" ? marker.source : null;
      const rawTarget = marker.target && typeof marker.target === "object" ? marker.target : null;
      const source = sanitizePoint(rawSource, "source");
      const target = sanitizePoint(rawTarget, "target");
      if (!source && !target) return;
      const id = typeof marker.id === "string" ? marker.id.trim() : "";
      const label = typeof marker.label === "string" ? marker.label.trim() : "";
      directPairs.push({ id, label, source: source || null, target: target || null, order: idx });
      return;
    }

    const type = String(marker.type || "").toLowerCase();
    if (type !== "start" && type !== "end") return;
    const tag = String(marker.tag || "").trim();
    if (!tag) return;

    const point = sanitizePoint(marker, type === "start" ? "source" : "target");
    if (!point) return;

    let entry = legacyByTag.get(tag);
    if (!entry) {
      entry = { tag, order: idx };
    } else {
      entry.order = Math.min(entry.order, idx);
    }
    if (type === "start") {
      entry.start = point;
    } else {
      entry.end = point;
    }
    legacyByTag.set(tag, entry);
  });

  const pairs = [...directPairs];

  legacyByTag.forEach((entry, tag) => {
    const source = entry.start || null;
    const target = entry.end || null;
    if (!source && !target) return;
    pairs.push({
      id: `legacy-${tag}`,
      label: "",
      source,
      target,
      order: entry.order,
    });
  });

  pairs.sort((a, b) => {
    const ao = Number.isFinite(a.order) ? a.order : 0;
    const bo = Number.isFinite(b.order) ? b.order : 0;
    return ao - bo;
  });

  const usedIds = new Set();
  const result = [];
  pairs.forEach((pair, idx) => {
    const baseId = pair.id && !usedIds.has(pair.id) ? pair.id : `jump-${idx + 1}`;
    let id = baseId;
    let counter = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${counter++}`;
    }
    usedIds.add(id);

    const label = pair.label || `Sprung ${result.length + 1}`;
    result.push({
      id,
      label,
      source: pair.source || null,
      target: pair.target || null,
    });
  });

  return result;
}

function annotationKey(rel) {
  const normalized = rel.split(path.sep).join("/");
  return normalized.split("/").map((segment) => encodeURIComponent(segment)).join("__");
}

function getAnnotationDir(rel) {
  return path.join(ANNOTATIONS_DIR, annotationKey(rel));
}

function getAnnotationIndexPath(rel) {
  return path.join(getAnnotationDir(rel), "index.json");
}

function getAnnotationBasePath(rel) {
  return path.join(getAnnotationDir(rel), "base.pdf");
}

function getAnnotationPagePath(rel, pageNumber) {
  return path.join(getAnnotationDir(rel), `page-${pageNumber}.png`);
}

function getAnnotationVersionsDir(rel) {
  return path.join(getAnnotationDir(rel), "versions");
}

async function ensureAnnotationVersionsDir(rel) {
  const dir = getAnnotationVersionsDir(rel);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

async function listAnnotationSnapshots(rel) {
  const dir = getAnnotationVersionsDir(rel);
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.endsWith("-pending"))
    .map((name) => {
      const [ts] = name.split("-");
      const timestamp = Number(ts) || 0;
      return {
        name,
        dir: path.join(dir, name),
        timestamp,
      };
    })
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.name.localeCompare(b.name);
    });
}

async function cleanupAnnotationSnapshots(rel) {
  const snapshots = await listAnnotationSnapshots(rel);
  if (snapshots.length <= MAX_ANNOTATION_VERSIONS) return;
  const overflow = snapshots.slice(0, Math.max(0, snapshots.length - MAX_ANNOTATION_VERSIONS));
  await Promise.all(
    overflow.map((entry) =>
      fs.promises.rm(entry.dir, { recursive: true, force: true }).catch(() => {})
    )
  );
}

async function createAnnotationSnapshot(info, index) {
  if (!info || !info.rel) return null;
  const versionsDir = await ensureAnnotationVersionsDir(info.rel);
  const baseTs = Date.now();
  let attempt = 0;
  let token = null;
  let dir = null;

  while (true) {
    token = attempt ? `${baseTs}-${attempt}` : `${baseTs}`;
    dir = path.join(versionsDir, `${token}-pending`);
    try {
      await fs.promises.mkdir(dir);
      break;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        attempt += 1;
        continue;
      }
      throw err;
    }
  }

  const snapshot = {
    rel: info.rel,
    dir,
    token,
    timestamp: Number(token.split("-")[0]) || Date.now(),
  };

  const pagesObject = index && typeof index === "object" && index.pages && typeof index.pages === "object"
    ? JSON.parse(JSON.stringify(index.pages))
    : {};
  const pageKeys = Object.keys(pagesObject)
    .map((key) => Number(key))
    .filter((num) => Number.isFinite(num) && num > 0)
    .sort((a, b) => a - b);

  const meta = {
    rel: info.rel,
    createdAt: Date.now(),
    pages: pageKeys,
  };

  await fs.promises.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  await fs.promises.writeFile(
    path.join(dir, "index.json"),
    JSON.stringify({ rel: info.rel, pages: pagesObject }, null, 2),
    "utf8"
  );

  for (const pageNumber of pageKeys) {
    const src = getAnnotationPagePath(info.rel, pageNumber);
    const dest = path.join(dir, `page-${pageNumber}.png`);
    try {
      await fs.promises.copyFile(src, dest);
    } catch (err) {
      if (!err || err.code !== "ENOENT") {
        console.warn(
          "Snapshot copy failed for annotation page",
          info.rel,
          pageNumber,
          err?.message || err
        );
      }
    }
  }

  return snapshot;
}

async function finalizeAnnotationSnapshot(snapshot) {
  if (!snapshot || !snapshot.dir) return null;
  const versionsDir = getAnnotationVersionsDir(snapshot.rel);
  const target = path.join(versionsDir, snapshot.token);
  try {
    await fs.promises.rename(snapshot.dir, target);
    const finalized = { ...snapshot, dir: target };
    await cleanupAnnotationSnapshots(snapshot.rel);
    return finalized;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    if (err && err.code === "EEXIST") {
      const uniqueTarget = `${target}-${Date.now()}`;
      await fs.promises.rename(snapshot.dir, uniqueTarget);
      const finalized = { ...snapshot, dir: uniqueTarget, token: path.basename(uniqueTarget) };
      await cleanupAnnotationSnapshots(snapshot.rel);
      return finalized;
    }
    throw err;
  }
}

async function discardAnnotationSnapshot(snapshot) {
  if (!snapshot || !snapshot.dir) return;
  await fs.promises.rm(snapshot.dir, { recursive: true, force: true }).catch(() => {});
}

async function getLatestAnnotationSnapshot(rel) {
  const snapshots = await listAnnotationSnapshots(rel);
  if (!snapshots.length) return null;
  return snapshots[snapshots.length - 1];
}

async function loadSnapshotIndex(snapshot) {
  if (!snapshot) return { rel: null, pages: {} };
  try {
    const raw = await fs.promises.readFile(path.join(snapshot.dir, "index.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { rel: null, pages: {} };
    if (!parsed.pages || typeof parsed.pages !== "object") parsed.pages = {};
    return parsed;
  } catch {
    return { rel: null, pages: {} };
  }
}

async function serializeAnnotationPages(info, index) {
  const pages = [];
  const map = index && typeof index === "object" && index.pages && typeof index.pages === "object"
    ? index.pages
    : {};
  const keys = Object.keys(map)
    .map((key) => Number(key))
    .filter((num) => Number.isInteger(num) && num > 0)
    .sort((a, b) => a - b);

  for (const pageNumber of keys) {
    const pagePath = getAnnotationPagePath(info.rel, pageNumber);
    let dataUrl = null;
    try {
      const buffer = await fs.promises.readFile(pagePath);
      if (buffer && buffer.length) {
        dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
      }
    } catch {}
    if (!dataUrl) continue;
    const meta = map[pageNumber] || map[String(pageNumber)] || {};
    pages.push({
      pageNumber,
      dataUrl,
      pageWidth: Number(meta.pageWidth) || null,
      pageHeight: Number(meta.pageHeight) || null,
    });
  }

  return pages;
}

async function ensureAnnotationStore(rel) {
  const dir = getAnnotationDir(rel);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

async function loadAnnotationIndex(rel) {
  const indexPath = getAnnotationIndexPath(rel);
  try {
    const raw = await fs.promises.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { rel, pages: {} };
    if (!parsed.pages || typeof parsed.pages !== "object") parsed.pages = {};
    return { rel, pages: parsed.pages };
  } catch {
    return { rel, pages: {} };
  }
}

async function saveAnnotationIndex(rel, index) {
  const indexPath = getAnnotationIndexPath(rel);
  const payload = JSON.stringify({ rel, pages: index.pages || {} }, null, 2);
  await fs.promises.writeFile(indexPath, payload, "utf8");
}

async function ensureAnnotationBase(info) {
  const basePath = getAnnotationBasePath(info.rel);
  try {
    await fs.promises.access(basePath, fs.constants.F_OK);
  } catch {
    await fs.promises.mkdir(path.dirname(basePath), { recursive: true });
    await fs.promises.copyFile(info.abs, basePath);
  }
  return basePath;
}

async function rebuildPdfFromAnnotations(info, index) {
  const basePath = await ensureAnnotationBase(info);
  const pages = index.pages || {};
  const pageKeys = Object.keys(pages);

  if (!pageKeys.length) {
    // No overlays: restore base
    const tmpPath = `${info.abs}.${Date.now()}.clean.tmp`;
    await fs.promises.copyFile(basePath, tmpPath);
    await fs.promises.rename(tmpPath, info.abs);
    return;
  }

  const baseBytes = await fs.promises.readFile(basePath);
  const pdfDoc = await PDFDocument.load(baseBytes, { ignoreEncryption: true });
  const pageCount = pdfDoc.getPageCount();

  for (const key of pageKeys) {
    const pageNumber = Number(key);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) continue;
    const overlayPath = getAnnotationPagePath(info.rel, pageNumber);
    let pngBytes;
    try {
      pngBytes = await fs.promises.readFile(overlayPath);
    } catch {
      continue;
    }
    if (!pngBytes.length) continue;
    let embedded;
    try {
      embedded = await pdfDoc.embedPng(pngBytes);
    } catch (err) {
      console.warn("Failed to embed annotation image", err?.message || err);
      continue;
    }
    const page = pdfDoc.getPage(pageNumber - 1);
    const meta = pages[key] || {};
    const width = Number(meta.pageWidth) || page.getWidth();
    const height = Number(meta.pageHeight) || page.getHeight();
    page.drawImage(embedded, { x: 0, y: 0, width, height });
  }

  const tmpPath = `${info.abs}.${Date.now()}.annot.tmp`;
  const pdfBytes = await pdfDoc.save({ useObjectStreams: false });
  await fs.promises.writeFile(tmpPath, pdfBytes);
  await fs.promises.rename(tmpPath, info.abs);
}

async function resetAnnotationStore(info) {
  const basePath = await ensureAnnotationBase(info);
  const dir = await ensureAnnotationStore(info.rel);

  const entries = await fs.promises.readdir(dir).catch(() => []);
  for (const entry of entries) {
    if (entry === "index.json") continue;
    if (entry === path.basename(basePath)) continue;
    if (entry.startsWith("page-") && entry.endsWith(".png")) {
      try {
        await fs.promises.unlink(path.join(dir, entry));
      } catch {}
    }
  }

  try {
    await fs.promises.unlink(getAnnotationIndexPath(info.rel));
  } catch {}

  const tmpPath = `${info.abs}.${Date.now()}.reset.tmp`;
  await fs.promises.copyFile(basePath, tmpPath);
  await fs.promises.rename(tmpPath, info.abs);
}

function slugifyPdfBase(name, fallback = "sheet") {
  if (typeof name !== "string") return fallback;
  const normalized = name
    .toString()
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || fallback;
}

function sanitizePdfFilename(name) {
  if (typeof name !== "string") return "sheet.pdf";
  // Remove only dangerous characters, keep original name structure
  const sanitized = name
    .replace(/[<>:"|?*\x00-\x1F]/g, "") // Remove illegal filename chars
    .replace(/\.\./g, "") // Remove parent directory references
    .trim();
  
  // Ensure it ends with .pdf
  if (!sanitized.toLowerCase().endsWith('.pdf')) {
    return sanitized + '.pdf';
  }
  
  return sanitized || "sheet.pdf";
}

function generateUniquePdfFilename(baseName) {
  const sanitized = sanitizePdfFilename(baseName);
  const ext = path.extname(sanitized);
  const nameWithoutExt = sanitized.slice(0, -ext.length);
  
  let candidate = sanitized;
  let counter = 2;
  while (fs.existsSync(path.join(SHEETS_DIR, candidate))) {
    candidate = `${nameWithoutExt} (${counter})${ext}`;
    counter++;
  }
  return candidate;
}

function decodeUploadHeader(value) {
  if (value === undefined || value === null) return "";
  const source = Array.isArray(value) ? value.join(",") : String(value);
  if (!source) return "";
  try {
    return decodeURIComponent(source);
  } catch {
    return source;
  }
}

async function writeFallbackThumbnail(targetPath) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.writeFile(targetPath, FALLBACK_THUMB_BUFFER);
}

function ensureUniqueCategoryId(candidate, existing) {
  let id = candidate;
  let counter = 2;
  while (existing.has(id)) {
    id = `${candidate}-${counter++}`;
  }
  return id;
}

function getCategoryById(id) {
  try {
    const store = userContext?.getRequestContext();
    if (store) {
      const { CONFIG } = userContext;
      return CONFIG.categories.find((cat) => cat.id === id);
    }
  } catch {
    // No user context - return null
  }
  return null;
}

function sanitizeCategoryIds(ids) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed) continue;
    if (!getCategoryById(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function refreshIndexCategoriesForFile(relPath) {
  const idx = indexCache.items.findIndex((entry) => entry && entry.name === relPath);
  if (idx === -1) return;
  
  try {
    const store = userContext?.getRequestContext();
    if (!store) return; // No user context
    
    const { CONFIG } = userContext;
    const fileCfg = CONFIG.files[relPath] || {};
    const catIds = sanitizeCategoryIds(fileCfg.categories || []);
    const categoriesDetailed = catIds
      .map((id) => {
        const cat = getCategoryById(id);
        return cat ? { ...cat } : null;
      })
      .filter(Boolean);
    indexCache.items[idx] = {
      ...indexCache.items[idx],
      categoryIds: catIds,
      categories: categoriesDetailed,
    };
  } catch {
    // No user context - skip refresh
  }
}

function refreshIndexCategoryMetadata(catId) {
  try {
    const store = userContext?.getRequestContext();
    if (!store) return; // No user context
    
    indexCache.items = indexCache.items.map((item) => {
      if (!item || !Array.isArray(item.categoryIds) || !item.categoryIds.includes(catId)) {
        return item;
      }
      const catIds = sanitizeCategoryIds(item.categoryIds);
      const categoriesDetailed = catIds
        .map((id) => {
          const cat = getCategoryById(id);
          return cat ? { ...cat } : null;
        })
        .filter(Boolean);
      return { ...item, categoryIds: catIds, categories: categoriesDetailed };
    });
  } catch {
    // No user context - skip refresh
  }
}

function removeCategoryFromFiles(catId) {
  try {
    const store = userContext?.getRequestContext();
    if (!store) return; // No user context
    
    const { CONFIG } = userContext;
    for (const [rel, cfg] of Object.entries(CONFIG.files)) {
      if (!cfg || !Array.isArray(cfg.categories)) continue;
      const filtered = cfg.categories.filter((id) => id !== catId);
      if (filtered.length !== cfg.categories.length) {
        cfg.categories = filtered;
        const hasMarkers = Array.isArray(cfg.jumpMarkers) && cfg.jumpMarkers.length > 0;
        if (!filtered.length && !cfg.secsPerPage && !hasMarkers) {
          delete CONFIG.files[rel];
        }
        refreshIndexCategoriesForFile(rel);
      }
    }
  } catch {
    // No user context - skip
  }
}

// Memory management settings
const MEMORY_SETTINGS = {
  maxIndexCacheAge: 300000,  // 5 min cache for file index (invalidated by watcher)
  maxVendorRetries: 3,       // Limit vendor download retries
  maxStatConcurrency: 32,    // Reduced from 64 for stability
  enableGzipCompression: true,
  thumbnailSize: 600,        // Thumbnail width in pixels
  thumbnailQuality: 100,      // JPEG quality for thumbnails
  maxThumbnailAge: 7 * 24 * 60 * 60 * 1000 // 7 days thumbnail cache
};

// Local vendor cache (offline/CDN failure resilience)
const VENDOR_DIR = path.join(DATA_DIR, "vendor");
const PDFJS_DIR = path.join(VENDOR_DIR, "pdfjs");
const PDFJS_VER = "3.11.174";
const VENDORS = {
  // pdf.js runtime + worker
  "pdfjs/pdf.min.js": `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.min.js`,
  "pdfjs/pdf.worker.min.js": `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.worker.min.js`,
  // fuse.js for search
  "fuse.min.js": "https://cdnjs.cloudflare.com/ajax/libs/fuse.js/7.0.0/fuse.min.js",
  // NoSleep fallback (for wake lock)
  "nosleep.min.js": "https://cdn.jsdelivr.net/npm/nosleep.js@0.12.0/dist/NoSleep.min.js",
};

// Ensure dirs
fs.mkdirSync(SHEETS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(VENDOR_DIR, { recursive: true });
fs.mkdirSync(PDFJS_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true }); // Create thumbnail directory

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
const annotationLocks = new Map();
const requestState = new AsyncLocalStorage();
class SizeLimiter extends Transform {
  constructor(limitBytes) {
    super();
    this.limitBytes = limitBytes;
    this.total = 0;
  }
  _transform(chunk, encoding, callback) {
    this.total += chunk.length;
    if (this.total > this.limitBytes) {
      const err = new Error("File too large");
      err.code = "LIMIT_FILE_SIZE";
      callback(err);
    } else {
      callback(null, chunk);
    }
  }
}

function toPosixPath(input) {
  return input.replace(/\\/g, "/");
}

function resolvePdfName(name, options = {}) {
  const { requireExists = true } = options;
  if (typeof name !== "string") {
    return null;
  }

  let candidate = name.trim();
  if (!candidate) {
    return null;
  }
  
  // SECURITY: Decode URL-encoding (verhindert double-encoding bypass)
  const original = candidate;
  try { 
    candidate = decodeURIComponent(candidate); 
  } catch (err) {
    console.warn('[SECURITY] Invalid URL encoding detected:', original);
    return null;
  }

  // SECURITY: Normalisiere Path
  const normalized = path.posix.normalize(toPosixPath(candidate));
  
  // SECURITY: Block Windows drive letters (C:, D:, etc.)
  if (/^[a-zA-Z]:/.test(normalized)) {
    console.warn('[SECURITY] Windows absolute path blocked:', name);
    return null;
  }
  
  // SECURITY: Strikte Validierung gegen Path Traversal
  if (!normalized || 
      normalized === "." || 
      normalized.startsWith("../") || 
      normalized.includes("/../") ||  // CRITICAL: Block traversal in middle of path
      normalized.includes("\\") ||    // Block Windows backslashes
      path.isAbsolute(normalized)) {
    console.warn('[SECURITY] Path traversal attempt blocked:', name);
    return null;
  }
  
  // SECURITY: Prüfe auf Null-Bytes (directory traversal bypass technique)
  if (candidate.includes('\0') || normalized.includes('\0')) {
    console.warn('[SECURITY] Null-byte injection attempt blocked:', name);
    return null;
  }
  
  // SECURITY: Nur PDF-Dateien erlauben
  if (!normalized.toLowerCase().endsWith(".pdf")) {
    return null;
  }

  // SECURITY: Validiere absoluten Pfad
  const abs = path.resolve(path.join(SHEETS_DIR, normalized));
  
  // SECURITY: CRITICAL - Stelle sicher dass Pfad innerhalb SHEETS_DIR bleibt
  const relativePath = path.relative(SHEETS_DIR, abs);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    console.warn('[SECURITY] Path escape attempt blocked:', name, '-> abs:', abs);
    return null;
  }

  if (requireExists) {
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) {
        return null;
      }
    } catch {
      return null;
    }
  }

  return { rel: normalized, abs };
}

function thumbnailRelPath(pdfRel) {
  return pdfRel.replace(/\.pdf$/i, ".jpg");
}

function encodePathSegments(relPath) {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

/* ---------------- Thumbnail Generation (Server-side) ---------------- */
async function ensureThumbnail(pdfInfo) {
  const relPdf = pdfInfo.rel;
  const pdfPath = pdfInfo.abs;
  const thumbRel = thumbnailRelPath(relPdf);
  const thumbPath = path.join(THUMBS_DIR, thumbRel);

  await fs.promises.mkdir(path.dirname(thumbPath), { recursive: true });

  const [thumbStat, pdfStat] = await Promise.all([
    statSafe(thumbPath),
    statSafe(pdfPath)
  ]);

  if (
    thumbStat &&
    pdfStat &&
    thumbStat.mtimeMs >= pdfStat.mtimeMs &&
    Date.now() - thumbStat.mtimeMs < MEMORY_SETTINGS.maxThumbnailAge
  ) {
    return { thumbPath, thumbStat };
  }

  if (!pdfjsLib || !canvas) {
    console.warn(`PDF.js or Canvas not available for ${relPdf}, using fallback thumbnail`);
    await writeFallbackThumbnail(thumbPath);
    const fallbackStat = await statSafe(thumbPath);
    return { thumbPath, thumbStat: fallbackStat };
  }

  try {
    await createThumbnailFromPdf(pdfPath, thumbPath, relPdf);
  } catch (err) {
    logError(`createThumbnailFromPdf failed`, err, { relPdf });
    await writeFallbackThumbnail(thumbPath);
  }
  const refreshedStat = await statSafe(thumbPath);
  return { thumbPath, thumbStat: refreshedStat };
}

async function createThumbnailFromPdf(pdfPath, thumbPath, relPdf) {
  const data = await fs.promises.readFile(pdfPath);

  const getDocument = pdfjsLib.getDocument || pdfjsLib;
  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    standardFontDataUrl: null,
    cMapUrl: null,
    cMapPacked: false
  });

  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);

  const baseViewport = page.getViewport({ scale: 1 });
  const scale = MEMORY_SETTINGS.thumbnailSize / baseViewport.width;
  const scaledViewport = page.getViewport({ scale });

  if (!canvas || typeof canvas.createCanvas !== "function") {
    throw new Error("Canvas library not available");
  }

  const canvasInstance = canvas.createCanvas(scaledViewport.width, scaledViewport.height);
  const context = canvasInstance.getContext("2d");

  await page.render({
    canvasContext: context,
    viewport: scaledViewport
  }).promise;

  let imageBuffer = canvasInstance.toBuffer("image/jpeg", {
    quality: MEMORY_SETTINGS.thumbnailQuality / 100
  });

  if (sharp && imageBuffer) {
    imageBuffer = await sharp(imageBuffer)
      .jpeg({ quality: MEMORY_SETTINGS.thumbnailQuality })
      .resize(MEMORY_SETTINGS.thumbnailSize, null, {
        withoutEnlargement: true,
        fit: "inside"
      })
      .toBuffer();
  }

  await fs.promises.mkdir(path.dirname(thumbPath), { recursive: true });
  await fs.promises.writeFile(thumbPath, imageBuffer);

  if (typeof page.cleanup === "function") page.cleanup();
  if (typeof pdf.cleanup === "function") pdf.cleanup();
  if (typeof pdf.destroy === "function") pdf.destroy();

  // console.log(`Generated thumbnail for: ${relPdf}`);
}

async function getThumbnailPath(relPdf) {
  const info = resolvePdfName(relPdf);
  if (!info) {
    throw new Error("PDF not found");
  }
  const { thumbPath } = await ensureThumbnail(info);
  return thumbPath;
}

/* ---------------- Robust download helper with timeout & atomic write ---------------- */
function downloadToFile(url, dest, timeoutMs = 10000, retries = 0) {
  return new Promise((resolve, reject) => {
    if (retries >= MEMORY_SETTINGS.maxVendorRetries) {
      return reject(new Error("Max retries exceeded"));
    }
    
    const tmp = dest + ".tmp";
    const out = fs.createWriteStream(tmp);
    const req = https.get(url, (resp) => {
      if (resp.statusCode !== 200) {
        out.close(() => fs.unlink(tmp, () => reject(new Error("HTTP " + resp.statusCode))));
        return;
      }
      resp.pipe(out);
      out.on("finish", () => out.close(() => {
        fs.rename(tmp, dest, (err) => {
          if (err) {
            fs.unlink(tmp, () => {});
            if (retries < MEMORY_SETTINGS.maxVendorRetries) {
              setTimeout(() => {
                downloadToFile(url, dest, timeoutMs, retries + 1).then(resolve).catch(reject);
              }, 1000 * (retries + 1));
            } else {
              reject(err);
            }
          } else {
            resolve();
          }
        });
      }));
    });
    req.on("timeout", () => { 
      req.destroy(new Error("download timeout")); 
    });
    req.setTimeout(timeoutMs);
    req.on("error", (err) => {
      out.close(() => fs.unlink(tmp, () => {
        if (retries < MEMORY_SETTINGS.maxVendorRetries) {
          setTimeout(() => {
            downloadToFile(url, dest, timeoutMs, retries + 1).then(resolve).catch(reject);
          }, 1000 * (retries + 1));
        } else {
          reject(err);
        }
      }));
    });
  });
}
async function ensureVendor(relPath, url) {
  const dest = path.join(VENDOR_DIR, relPath);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await downloadToFile(url, dest);
  return dest;
}
async function ensureVendors() {
  const tasks = Object.entries(VENDORS).map(([rel, url]) => ensureVendor(rel, url).catch(() => null));
  await Promise.all(tasks);
}

/* ---------------- User-scoped config & playlists (database-backed) ---------------- */
const DEFAULT_CONFIG = { favorites: [], files: {}, categories: [] };

function normalizeConfig(rawInput) {
  const source = rawInput && typeof rawInput === "object" ? rawInput : {};
  const favoritesRaw = Array.isArray(source.favorites) ? source.favorites : [];
  const favorites = favoritesRaw
    .map((name) => {
      const info = resolvePdfName(name, { requireExists: true });
      return info ? info.rel : null;
    })
    .filter(Boolean);

  const categoriesRaw = Array.isArray(source.categories) ? source.categories : [];
  const seenIds = new Set();
  const categories = [];
  for (const entry of categoriesRaw) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    const baseId = entry.id && typeof entry.id === "string" ? entry.id.trim() : slugifyCategoryId(name);
    const uniqueId = ensureUniqueCategoryId(slugifyCategoryId(baseId || name), seenIds);
    seenIds.add(uniqueId);
    categories.push({
      id: uniqueId,
      name,
      color: sanitizeHexColor(entry.color || DEFAULT_CATEGORY_COLOR),
      icon: sanitizeCategoryIcon(entry.icon),
    });
  }

  const validCatIds = new Set(categories.map((cat) => cat.id));

  const files = {};
  if (source.files && typeof source.files === "object") {
    for (const [key, value] of Object.entries(source.files)) {
      const info = resolvePdfName(key, { requireExists: false });
      if (!info || !value || typeof value !== "object") continue;
      const entry = {};
      if (value.secsPerPage) {
        const secs = Number(value.secsPerPage);
        if (Number.isFinite(secs) && secs >= 5 && secs <= 600) entry.secsPerPage = secs;
      }
      if (Array.isArray(value.categories)) {
        entry.categories = value.categories
          .map((id) => (typeof id === "string" ? id.trim() : null))
          .filter((id) => id && validCatIds.has(id));
      }
      if (Array.isArray(value.jumpMarkers)) {
        const markers = sanitizeJumpMarkers(value.jumpMarkers);
        if (markers.length) entry.jumpMarkers = markers;
      }
      if (Object.keys(entry).length) {
        files[info.rel] = entry;
      }
    }
  }

  const favList = Array.from(new Set(favorites)).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
  );

  return {
    favorites: favList,
    files,
    categories,
  };
}

function createDefaultPlaylistState() {
  const initialPlaylist = createPlaylist({ name: "Setlist" });
  return {
    playlists: [initialPlaylist],
    activeId: initialPlaylist.id,
    updatedAt: initialPlaylist.updatedAt,
  };
}

const userConfigCache = new Map();
const userPlaylistCache = new Map();
const userDocumentCache = new Map();

async function ensureUserConfig(userId) {
  let entry = userConfigCache.get(userId);
  if (entry) return entry;
  if (!dataStore) throw new Error("Data store not initialised");
  const raw = await dataStore.getUserConfig(userId);
  const normalized = normalizeConfig(raw);
  entry = { config: normalized, dirty: false };
  userConfigCache.set(userId, entry);
  return entry;
}

async function ensureUserPlaylists(userId) {
  let entry = userPlaylistCache.get(userId);
  if (entry) return entry;
  if (!dataStore) throw new Error("Data store not initialised");
  let normalized = sanitizePlaylistsState(await dataStore.getUserPlaylists(userId));
  if (!normalized) {
    normalized = createDefaultPlaylistState();
  }
  entry = { state: normalized, dirty: false };
  userPlaylistCache.set(userId, entry);
  return entry;
}

async function ensureUserDocuments(userId) {
  let set = userDocumentCache.get(userId);
  if (set) return set;
  if (!dataStore) throw new Error("Data store not initialised");
  const relPaths = await dataStore.listUserDocumentRelPaths(userId);
  set = new Set(Array.isArray(relPaths) ? relPaths : []);
  userDocumentCache.set(userId, set);
  return set;
}

function addDocumentsToUserCache(userId, relPaths) {
  if (!Array.isArray(relPaths) || !relPaths.length) return;
  const set = userDocumentCache.get(userId);
  if (!set) return;
  relPaths.forEach((rel) => {
    if (typeof rel === "string" && rel) set.add(rel);
  });
}

function getRequestContext() {
  return requestState.getStore() || null;
}

function requireUserContext() {
  const store = getRequestContext();
  if (!store || !store.configEntry || !store.playlistEntry) {
    throw new Error("User context not initialised for this request");
  }
  return store;
}

function markConfigDirty() {
  const store = getRequestContext();
  if (store?.configEntry) {
    store.configEntry.dirty = true;
  }
}

async function saveConfigImmediate() {
  const store = getRequestContext();
  if (!store || !store.configEntry || !store.configEntry.dirty) return;
  await dataStore.saveUserConfig(store.userId, store.configEntry.config);
  store.configEntry.dirty = false;
}

async function persistConfigNow() {
  markConfigDirty();
  await saveConfigImmediate();
}

async function ensureConfigFresh() {
  // Config is loaded per request via middleware.
}

function markPlaylistsDirty() {
  const store = getRequestContext();
  if (store?.playlistEntry) {
    store.playlistEntry.dirty = true;
    store.playlistEntry.state.updatedAt = Date.now();
  }
}

async function savePlaylistsImmediate() {
  const store = getRequestContext();
  if (!store || !store.playlistEntry || !store.playlistEntry.dirty) return;
  await dataStore.saveUserPlaylists(store.userId, store.playlistEntry.state);
  store.playlistEntry.dirty = false;
}

async function flushConfigBeforeExit() {
  if (!dataStore) return;
  for (const [userId, entry] of userConfigCache.entries()) {
    if (entry?.dirty) {
      try {
        await dataStore.saveUserConfig(userId, entry.config);
        entry.dirty = false;
      } catch (err) {
        logError("Failed to flush config", err, { userId });
      }
    }
  }
  for (const [userId, entry] of userPlaylistCache.entries()) {
    if (entry?.dirty) {
      try {
        await dataStore.saveUserPlaylists(userId, entry.state);
        entry.dirty = false;
      } catch (err) {
        logError("Failed to flush playlists", err, { userId });
      }
    }
  }
}

const CONFIG = new Proxy({}, {
  get(_target, prop) {
    const store = requireUserContext();
    return store.configEntry.config[prop];
  },
  set(_target, prop, value) {
    const store = requireUserContext();
    store.configEntry.config[prop] = value;
    store.configEntry.dirty = true;
    return true;
  },
  deleteProperty(_target, prop) {
    const store = requireUserContext();
    delete store.configEntry.config[prop];
    store.configEntry.dirty = true;
    return true;
  }
});

const PLAYLIST_STATE = new Proxy({}, {
  get(_target, prop) {
    const store = requireUserContext();
    return store.playlistEntry.state[prop];
  },
  set(_target, prop, value) {
    const store = requireUserContext();
    store.playlistEntry.state[prop] = value;
    store.playlistEntry.dirty = true;
    return true;
  },
  deleteProperty(_target, prop) {
    const store = requireUserContext();
    delete store.playlistEntry.state[prop];
    store.playlistEntry.dirty = true;
    return true;
  }
});

// REMOVED: Old SSE client management - now handled by sseManager
// const playlistActiveClients = new Map();
// const playlistStateClients = new Map();

const PLAYLIST_ICON_FALLBACK = "🎵";
const PLAYLIST_COLOR_PALETTE = [
  "#6366F1",
  "#D946EF",
  "#F97316",
  "#0EA5E9",
  "#22C55E",
  "#F59E0B",
  "#EC4899",
  "#14B8A6",
  "#A855F7",
  "#F43F5E"
];

function createPlaylistId() {
  if (typeof randomUUID === "function") {
    try { return randomUUID(); } catch {}
  }
  return `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pickAccentColor(index = 0) {
  if (!Array.isArray(PLAYLIST_COLOR_PALETTE) || !PLAYLIST_COLOR_PALETTE.length) {
    return sanitizeHexColor(DEFAULT_CATEGORY_COLOR);
  }
  const len = PLAYLIST_COLOR_PALETTE.length;
  const idx = ((index % len) + len) % len;
  return sanitizeHexColor(PLAYLIST_COLOR_PALETTE[idx]);
}

function sanitizePlaylistName(name, fallback = "Setlist") {
  if (typeof name !== "string") return fallback;
  const trimmed = name.trim();
  return trimmed || fallback;
}

function sanitizePlaylistIcon(icon) {
  if (typeof icon !== "string") return PLAYLIST_ICON_FALLBACK;
  const trimmed = icon.trim();
  if (!trimmed) return PLAYLIST_ICON_FALLBACK;
  return trimmed.slice(0, 2);
}

function sanitizeAccentColor(color, paletteIndex = 0) {
  if (typeof color === "string" && color.trim()) {
    return sanitizeHexColor(color);
  }
  return pickAccentColor(paletteIndex);
}

function sanitizePlaylistEntry(raw, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const now = Date.now();
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : createPlaylistId();
  const name = sanitizePlaylistName(raw.name, `Playlist ${index + 1}`);
  const icon = sanitizePlaylistIcon(raw.icon || raw.emoji);
  const accentColor = sanitizeAccentColor(raw.accentColor, index);
  const itemsRaw = Array.isArray(raw.items) ? raw.items : [];
  const normalizedItems = ensureUniqueOrder(itemsRaw.map((name) => normalizeRelName(name)).filter(Boolean));
  let currentIndex = Number.isInteger(raw.currentIndex) ? raw.currentIndex : (normalizedItems.length ? 0 : -1);
  if (!normalizedItems.length) currentIndex = -1;
  else currentIndex = Math.max(-1, Math.min(normalizedItems.length - 1, currentIndex));
  const createdAt = Number(raw.createdAt) || now;
  const updatedAt = Number(raw.updatedAt) || now;
  return { id, name, icon, accentColor, items: normalizedItems, currentIndex, createdAt, updatedAt };
}

function createPlaylist(options = {}, meta = {}) {
  const now = Date.now();
  const index = typeof meta.paletteIndex === "number" ? meta.paletteIndex : 0;
  const entry = sanitizePlaylistEntry({
    id: createPlaylistId(),
    name: options.name,
    icon: options.icon,
    emoji: options.emoji,
    accentColor: options.accentColor,
    items: options.items,
    currentIndex: options.currentIndex,
    createdAt: now,
    updatedAt: now
  }, index);
  entry.createdAt = now;
  entry.updatedAt = now;
  return entry;
}

function sanitizePlaylistsState(raw) {
  if (!raw || typeof raw !== "object") return null;
  const list = Array.isArray(raw.playlists) ? raw.playlists : [];
  const seen = new Set();
  const sanitized = [];
  list.forEach((entry, idx) => {
    const sanitizedEntry = sanitizePlaylistEntry(entry, idx);
    if (!sanitizedEntry) return;
    if (seen.has(sanitizedEntry.id)) {
      sanitizedEntry.id = createPlaylistId();
    }
    seen.add(sanitizedEntry.id);
    sanitized.push(sanitizedEntry);
  });
  if (!sanitized.length) return null;
  const activeId = typeof raw.activeId === "string" && seen.has(raw.activeId) ? raw.activeId : sanitized[0].id;
  const updatedAt = Number(raw.updatedAt) || Math.max(...sanitized.map((pl) => pl.updatedAt));
  return { playlists: sanitized, activeId, updatedAt };
}

function convertLegacyPlaylist(raw) {
  if (!raw || typeof raw !== "object") return null;
  const converted = sanitizePlaylistEntry({
    id: raw.id,
    name: raw.name,
    items: raw.items,
    currentIndex: raw.currentIndex,
    accentColor: raw.accentColor,
    icon: raw.icon,
    emoji: raw.emoji,
    createdAt: raw.updatedAt,
    updatedAt: raw.updatedAt
  }, 0);
  if (!converted) return null;
  return { playlists: [converted], activeId: converted.id, updatedAt: converted.updatedAt };
}

function ensurePlaylistFile(state) {
  try {
    fs.mkdirSync(path.dirname(PLAYLISTS_FILE), { recursive: true });
    fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    logError("ensurePlaylistFile failed", err);
  }
}

function loadPlaylists() {
  const readJson = (file) => {
    try {
      const raw = fs.readFileSync(file, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  let state = sanitizePlaylistsState(readJson(PLAYLISTS_FILE));
  if (state) return state;

  const legacy = convertLegacyPlaylist(readJson(LEGACY_PLAYLIST_FILE));
  if (legacy) {
    ensurePlaylistFile(legacy);
    return legacy;
  }

  const initialPlaylist = createPlaylist({ name: "Setlist" });
  const initial = { playlists: [initialPlaylist], activeId: initialPlaylist.id, updatedAt: initialPlaylist.updatedAt };
  ensurePlaylistFile(initial);
  return initial;
}

// REMOVED: Old global PLAYLIST_STATE - now managed per-user via userContext
// let PLAYLIST_STATE = loadPlaylists();
let _playlistSaveInProgress = null;

function clonePlaylist(playlist) {
  return {
    id: playlist.id,
    name: playlist.name,
    icon: playlist.icon,
    accentColor: playlist.accentColor,
    items: playlist.items.slice(),
    currentIndex: playlist.currentIndex,
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt,
    itemCount: playlist.items.length
  };
}

function serializePlaylistState(state) {
  return {
    activeId: state.activeId,
    updatedAt: state.updatedAt,
    playlists: state.playlists.map((pl) => clonePlaylist(pl))
  };
}

function getActivePlaylist() {
  const { PLAYLIST_STATE } = userContext;
  return PLAYLIST_STATE.playlists.find((pl) => pl.id === PLAYLIST_STATE.activeId) || PLAYLIST_STATE.playlists[0] || null;
}

function serializeActivePlaylist() {
  const active = getActivePlaylist();
  if (!active) {
    const now = Date.now();
    return {
      id: null,
      name: null,
      icon: PLAYLIST_ICON_FALLBACK,
      accentColor: pickAccentColor(0),
      items: [],
      currentIndex: -1,
      createdAt: now,
      updatedAt: now,
      itemCount: 0
    };
  }
  return clonePlaylist(active);
}

function ensureActivePlaylistPresent() {
  const { PLAYLIST_STATE } = userContext;
  if (!PLAYLIST_STATE.playlists.length) {
    const created = createPlaylist({ name: "Setlist" });
    PLAYLIST_STATE.playlists.push(created);
    PLAYLIST_STATE.activeId = created.id;
    PLAYLIST_STATE.updatedAt = created.updatedAt;
    return created;
  }
  const active = getActivePlaylist();
  if (active) return active;
  PLAYLIST_STATE.activeId = PLAYLIST_STATE.playlists[0].id;
  return PLAYLIST_STATE.playlists[0];
}

// REMOVED: Old savePlaylistsImmediate() function - now inside registerApiRoutes() using dataStore

// REMOVED: Old SSE client sets - now handled by sseManager
// const playlistActiveClients = new Set();
// const playlistStateClients = new Set();

function broadcastPlaylists(userId = null) {
  // Broadcast to ALL active sessions of the user (multi-device sync)
  if (!userContext || !sseManager) {
    console.warn("broadcastPlaylists called but userContext or sseManager not initialized");
    return;
  }
  
  // Try to get userId from parameter first, then from context
  let targetUserId = userId;
  if (!targetUserId) {
    const store = userContext.getRequestContext();
    targetUserId = store?.userId;
  }
  
  if (!targetUserId) {
    console.warn("broadcastPlaylists called without user context or userId");
    return;
  }
  
  try {
    const { PLAYLIST_STATE } = userContext;
    const activePayload = serializeActivePlaylist();
    const statePayload = serializePlaylistState(PLAYLIST_STATE);
    
    // SSE-Manager broadcastet bereits an alle Clients des Users
    const sentActive = sseManager.broadcast(
      targetUserId,
      "playlist-active",
      activePayload,
      "playlist-active"
    );
    const sentState = sseManager.broadcast(
      targetUserId,
      "playlist-state",
      statePayload,
      "playlist-state"
    );
    
    console.log(`[SSE] Broadcasted playlist update to ${sentActive + sentState} clients for user ${targetUserId} (active: ${sentActive}, state: ${sentState})`);
    console.log(`[SSE] Active payload:`, JSON.stringify(activePayload).substring(0, 200) + '...');
    console.log(`[SSE] State payload:`, JSON.stringify(statePayload).substring(0, 200) + '...');
  } catch (err) {
    logError("Broadcast failed", err, { userId: targetUserId });
  }
}function updatePlaylistTimestamp(playlist) {
  const now = Date.now();
  playlist.updatedAt = now;
  const { PLAYLIST_STATE } = userContext;
  PLAYLIST_STATE.updatedAt = now;
}

function buildDefaultPlaylistName() {
  const base = "Playlist";
  const { PLAYLIST_STATE } = userContext;
  const seen = new Set(PLAYLIST_STATE.playlists.map((pl) => pl.name.toLowerCase()));
  let idx = PLAYLIST_STATE.playlists.length + 1;
  let candidate = `${base} ${idx}`;
  while (seen.has(candidate.toLowerCase())) {
    idx += 1;
    candidate = `${base} ${idx}`;
  }
  return candidate;
}

function addItemToPlaylist(playlist, rel) {
  if (playlist.items.includes(rel)) return false;
  playlist.items.push(rel);
  updatePlaylistTimestamp(playlist);
  return true;
}

function removeItemFromPlaylist(playlist, rel) {
  const idx = playlist.items.indexOf(rel);
  if (idx === -1) return false;
  playlist.items.splice(idx, 1);
  if (playlist.currentIndex >= idx) {
    playlist.currentIndex = Math.max(-1, playlist.currentIndex - 1);
  }
  updatePlaylistTimestamp(playlist);
  return true;
}

function clearPlaylistItems(playlist) {
  if (!playlist.items.length && playlist.currentIndex === -1) return false;
  playlist.items = [];
  playlist.currentIndex = -1;
  updatePlaylistTimestamp(playlist);
  return true;
}

function ensureUniqueOrder(items) {
  const seen = new Set();
  const out = [];
  for (const rel of items) {
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

function reorderPlaylistItems(playlist, rels) {
  const unique = ensureUniqueOrder(rels);
  playlist.items = unique;
  if (!playlist.items.length) {
    playlist.currentIndex = -1;
  } else if (typeof playlist.currentIndex === "number") {
    playlist.currentIndex = Math.max(-1, Math.min(playlist.items.length - 1, playlist.currentIndex));
  }
  updatePlaylistTimestamp(playlist);
  return true;
}

function setPlaylistItems(playlist, rels, currentIndex) {
  const unique = ensureUniqueOrder(rels);
  playlist.items = unique;
  if (Number.isInteger(currentIndex)) {
    playlist.currentIndex = Math.max(-1, Math.min(playlist.items.length - 1, currentIndex));
  } else {
    playlist.currentIndex = playlist.items.length ? 0 : -1;
  }
  updatePlaylistTimestamp(playlist);
  return true;
}

function setPlaylistCurrentIndex(playlist, index) {
  playlist.currentIndex = Math.max(-1, Math.min(playlist.items.length - 1, index));
  updatePlaylistTimestamp(playlist);
  return true;
}

function removePlaylistById(id) {
  const { PLAYLIST_STATE } = userContext;
  const idx = PLAYLIST_STATE.playlists.findIndex((pl) => pl.id === id);
  if (idx === -1) return false;
  PLAYLIST_STATE.playlists.splice(idx, 1);
  if (!PLAYLIST_STATE.playlists.length) {
    const created = createPlaylist({ name: "Setlist" });
    PLAYLIST_STATE.playlists.push(created);
    PLAYLIST_STATE.activeId = created.id;
    PLAYLIST_STATE.updatedAt = created.updatedAt;
  } else if (PLAYLIST_STATE.activeId === id) {
    PLAYLIST_STATE.activeId = PLAYLIST_STATE.playlists[0].id;
    PLAYLIST_STATE.updatedAt = Date.now();
  } else {
    PLAYLIST_STATE.updatedAt = Date.now();
  }
  return true;
}

function findPlaylistOrFail(id) {
  ensureActivePlaylistPresent();
  const { PLAYLIST_STATE } = userContext;
  return PLAYLIST_STATE.playlists.find((pl) => pl.id === id) || null;
}

/* ---------------- Playlist API (REST + SSE) ---------------- */
// CRITICAL: JSON body parser middleware must come BEFORE routes that need it
app.use(express.json({ limit: "20mb" }));

/* ---------------- Index Cache (Global) ---------------- */
let indexCache = { at: 0, items: [], scanInProgress: false };

async function statSafe(full) {
  try { return await fs.promises.stat(full); } catch { return null; }
}

// Function to register auth middleware and all API routes - called after initialization
function registerApiRoutes() {
  // SECURITY: Rate Limiters - Protect against brute force and DoS
  let loginLimiter = null;
  let uploadLimiter = null;
  let apiLimiter = null;
  
  if (rateLimit) {
    // Login Rate Limiter - Prevent brute force attacks
    loginLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 5, // Max 5 login attempts per window
      message: { error: "Zu viele Login-Versuche. Bitte warten Sie 15 Minuten." },
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: true, // Don't count successful logins
      handler: (req, res) => {
        console.warn('[SECURITY] Rate limit exceeded for login from:', req.ip);
        res.status(429).json({ 
          error: "Zu viele Login-Versuche. Bitte warten Sie 15 Minuten.",
          retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
        });
      }
    });
    
    // Upload Rate Limiter - Prevent upload spam
    uploadLimiter = rateLimit({
      windowMs: 60 * 1000, // 1 minute
      max: 10, // Max 10 uploads per minute
      message: { error: "Upload-Limit erreicht. Bitte warten Sie." },
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        console.warn('[SECURITY] Rate limit exceeded for upload from:', req.ip);
        res.status(429).json({ 
          error: "Upload-Limit erreicht. Bitte warten Sie.",
          retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
        });
      }
    });
    
    // General API Rate Limiter - Prevent API abuse
    apiLimiter = rateLimit({
      windowMs: 60 * 1000, // 1 minute
      max: 500, // Max 500 requests per minute (erhöht für große Bibliotheken)
      message: { error: "Zu viele Anfragen. Bitte warten Sie." },
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => {
        // Skip rate limiting for static files and authenticated batch requests
        return req.path.startsWith('/vendor/') || 
               req.path.startsWith('/sheets/') ||
               req.path.startsWith('/thumbnails/') ||
               req.path === '/share/info/batch'; // Skip für batch endpoint
      },
      handler: (req, res) => {
        console.warn('[SECURITY] Rate limit exceeded for API from:', req.ip);
        res.status(429).json({ 
          error: "Zu viele Anfragen. Bitte warten Sie.",
          retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
        });
      }
    });
    
    console.log('[SECURITY] Rate limiting enabled');
  } else {
    console.warn('[SECURITY] Rate limiting disabled - express-rate-limit not installed');
  }
  
  // Session middleware - extracts session from cookie and sets req.auth
  // Must run BEFORE user context middleware
  app.use((req, res, next) => {
    if (!authService) return next();
    const cookies = parseCookies(req);
    const sessionId = cookies[SESSION_COOKIE_NAME];
    if (!sessionId) return next();

    try {
      const context = authService.getSessionWithUser(sessionId);
      if (!context) {
        clearSessionCookie(res);
        return next();
      }

      const expiryMs = new Date(context.session.expiresAt).getTime();
      if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) {
        authService.deleteSession(sessionId);
        clearSessionCookie(res);
        return next();
      }

      if (!context.user.isActive) {
        authService.deleteSession(sessionId);
        clearSessionCookie(res);
        return next();
      }

      req.auth = {
        sessionId,
        session: context.session,
        user: authService.toPublicUser(context.user),
      };
    } catch (err) {
      logError("Session lookup failed", err, { sessionId });
    }

    next();
  });

  // User context middleware - loads user data based on req.auth.user
  // Must run AFTER session middleware, BEFORE routes
  app.use(userContext.middleware);

  // API routes defined below execute after both middlewares
  
  // SECURITY: Apply general API rate limiting to all /api/* routes
  if (apiLimiter) {
    app.use('/api/', apiLimiter);
  }

// =============================================================================
// AUTH ENDPOINTS (BEFORE CSRF Protection!)
// =============================================================================

app.post("/api/auth/login", loginLimiter || ((req, res, next) => next()), (req, res) => {
  if (!authService) {
    return res.status(503).json({ error: "Auth service unavailable" });
  }
  const { email, password } = req.body || {};
  if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
    return res.status(400).json({ error: "INVALID_CREDENTIALS" });
  }

  // SECURITY: User-based rate limiting check
  const rateLimitCheck = checkRateLimit(email);
  if (!rateLimitCheck.allowed) {
    console.warn('[SECURITY] Login rate limit exceeded:', { 
      email: email.substring(0, 3) + '***',
      ip: req.ip 
    });
    return res.status(429).json({ 
      error: "TOO_MANY_ATTEMPTS",
      message: rateLimitCheck.reason
    });
  }

  const record = authService.getUserByEmail(email);
  if (!record) {
    recordFailedLogin(email);
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }
  if (!record.isActive) {
    recordFailedLogin(email);
    return res.status(403).json({ error: "USER_DISABLED" });
  }

  const valid = authService.verifyPassword(password, record.passwordEncrypted);
  if (!valid) {
    recordFailedLogin(email);
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }
  
  // SECURITY: Clear failed login attempts on successful login
  recordSuccessfulLogin(email);

  // Update last login timestamp
  authService.updateLastLogin(record.id);

  // SECURITY: Enhanced Session Fixation Prevention
  // Delete any existing session before creating new one, but validate ownership first
  const oldSessionId = req.auth?.sessionId || parseCookies(req)[SESSION_COOKIE_NAME];
  if (oldSessionId) {
    try {
      const oldSession = authService.getSessionWithUser(oldSessionId);
      
      // Only delete if session belongs to the same user or is invalid
      if (!oldSession || oldSession.user.email === email) {
        authService.deleteSession(oldSessionId);
        console.log('[SECURITY] Deleted old session during login');
      } else {
        // Session belongs to different user - potential session adoption attack!
        console.warn('[SECURITY] Session adoption attempt blocked:', {
          requestedEmail: email.substring(0, 3) + '***',
          sessionUserEmail: oldSession.user.email.substring(0, 3) + '***',
          ip: req.ip
        });
        // Clear the malicious cookie
        clearSessionCookie(res);
      }
    } catch (err) {
      console.warn('[SECURITY] Failed to validate old session:', err?.message);
      // On error, clear cookie to be safe
      clearSessionCookie(res);
    }
  }
  
  // Always clear cookie before setting new one (defense in depth)
  clearSessionCookie(res);

  // Create new session with fresh random ID
  const session = authService.createSession(record.id);
  if (!session) {
    return res.status(500).json({ error: "FAILED_TO_CREATE_SESSION" });
  }

  // SECURITY: Generate CSRF token for this session
  const csrfToken = generateCsrfToken(session.id);

  setSessionCookie(res, session.id, session.expiresAt);
  const user = authService.toPublicUser(record);
  res.json({ ok: true, user, csrfToken });
});

app.post("/api/auth/logout", (req, res) => {
  if (!authService) {
    return res.status(503).json({ error: "Auth service unavailable" });
  }
  const sessionId = req.auth?.sessionId || parseCookies(req)[SESSION_COOKIE_NAME];
  if (sessionId) {
    try { authService.deleteSession(sessionId); } catch {}
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/session", (req, res) => {
  if (!authService) {
    return res.status(503).json({ error: "Auth service unavailable" });
  }
  if (!req.auth || !req.auth.user) {
    return res.json({ ok: false });
  }

  const { sessionId, session, user } = req.auth;
  
  // SECURITY: Retrieve or generate CSRF token for this session
  let csrfToken = csrfTokens.get(sessionId)?.token;
  if (!csrfToken) {
    // Generate new token (happens after server restart or token expiry)
    console.log('[CSRF] Generating CSRF token for session:', sessionId);
    csrfToken = generateCsrfToken(sessionId, true); // force=true to ensure creation
  }
  
  const timeLeft = new Date(session.expiresAt).getTime() - Date.now();
  if (timeLeft < SESSION_RENEW_THRESHOLD_MS) {
    const refreshed = authService.touchSession(sessionId);
    if (refreshed) {
      setSessionCookie(res, sessionId, refreshed);
      session.expiresAt = refreshed;
    }
  }

  res.json({ ok: true, user, session, csrfToken });
});

// =============================================================================
// CSRF PROTECTION (Applied AFTER Auth Endpoints)
// =============================================================================
// All /api/* routes below this point require CSRF tokens (except GET)
app.use('/api/', csrfProtection);

// =============================================================================
// VERSION API ENDPOINT
// =============================================================================
app.get("/api/version", (req, res) => {
  // No authentication required for version endpoint
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate"); // Always validate for freshest version
  res.json({
    version: "5.0.8",
    buildTime: Date.now()
  });
});

// =============================================================================
// ADMIN & USER API ENDPOINTS
// =============================================================================

app.get("/api/admin/users", async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const users = authService.listUsers();
  
  // Calculate real statistics for each user from their documents
  const usersWithStats = await Promise.all(users.map(async (user) => {
    try {
      const userDocs = dataStore.listUserDocumentRelPaths(user.id);
      const pdfCount = userDocs.length;
      
      // Calculate storage by scanning all assigned PDFs
      let storageBytes = 0;
      const all = await getIndex();
      const userDocSet = new Set(userDocs);
      const userPdfs = all.filter(item => userDocSet.has(item.name));
      
      for (const pdf of userPdfs) {
        storageBytes += pdf.size || 0;
      }
      
      return {
        ...user,
        pdfCount,
        storageBytes,
      };
    } catch (err) {
      logError(`Failed to calculate stats for user`, err, { userId: user.id });
      return user;
    }
  }));
  
  res.json({ ok: true, users: usersWithStats });
});

app.post("/api/admin/users", (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const { email, password, role = "user", isActive = true, pdfCount = 0, storageBytes = 0 } = req.body || {};
  const pdfCountValue = Number(pdfCount);
  const storageBytesValue = Number(storageBytes);
  try {
    const user = authService.createUser({
      email,
      password,
      role,
      isActive: Boolean(isActive),
      pdfCount: Number.isFinite(pdfCountValue) ? pdfCountValue : 0,
      storageBytes: Number.isFinite(storageBytesValue) ? storageBytesValue : 0,
    });
    res.status(201).json({ ok: true, user });
  } catch (err) {
    if (err.code === "E_EMAIL_REQUIRED" || err.code === "E_PASSWORD_WEAK" || err.code === "E_ROLE_INVALID") {
      return res.status(400).json({ error: err.code });
    }
    if (err.code === "E_EMAIL_EXISTS") {
      return res.status(409).json({ error: err.code });
    }
    sendError(res, 500, "FAILED_TO_CREATE_USER", err, "Admin create user");
  }
});

app.patch("/api/admin/users/:id", (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const { id } = req.params;
  const payload = req.body || {};
  const existing = authService.getUserById(id);
  if (!existing) {
    return res.status(404).json({ error: "USER_NOT_FOUND" });
  }

  const updates = {};
  if (Object.prototype.hasOwnProperty.call(payload, "isActive")) {
    updates.isActive = Boolean(payload.isActive);
  }
  if (payload.role !== undefined) {
    updates.role = payload.role;
  }

  if ((updates.role && updates.role !== "admin") || updates.isActive === false) {
    if (isSoleActiveAdmin(id)) {
      return res.status(400).json({ error: "LAST_ADMIN_RESTRICTION" });
    }
  }

  // Prevent admin from deactivating or demoting themselves
  if (req.auth.user.id === id) {
    if (updates.isActive === false) {
      return res.status(400).json({ error: "CANNOT_DEACTIVATE_SELF" });
    }
    if (updates.role && updates.role !== "admin") {
      return res.status(400).json({ error: "CANNOT_DEMOTE_SELF" });
    }
  }

  if (updates.role !== undefined || updates.isActive !== undefined) {
    try {
      authService.setUserStatus(id, updates);
    } catch (err) {
      if (err.code === "E_ROLE_INVALID") {
        return res.status(400).json({ error: err.code });
      }
      return sendError(res, 500, "FAILED_TO_UPDATE_USER", err, "Admin update user status");
    }
  }

  if (payload.pdfCount !== undefined || payload.storageBytes !== undefined) {
    authService.updateUserUsage(id, {
      pdfCount: Number(payload.pdfCount),
      storageBytes: Number(payload.storageBytes),
    });
  }

  if (payload.password) {
    try {
      authService.resetPassword(id, payload.password);
    } catch (err) {
      if (err.code === "E_PASSWORD_WEAK") {
        return res.status(400).json({ error: err.code });
      }
      return sendError(res, 500, "FAILED_TO_UPDATE_USER", err, "Admin reset password");
    }
  }

  const updated = authService.getUserById(id);
  res.json({ ok: true, user: updated });
});

app.delete("/api/admin/users/:id", (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const { id } = req.params;
  const existing = authService.getUserById(id);
  if (!existing) {
    return res.status(404).json({ error: "USER_NOT_FOUND" });
  }

  // Prevent admin from deleting themselves
  if (req.auth.user.id === id) {
    return res.status(400).json({ error: "CANNOT_DELETE_SELF" });
  }

  if (isSoleActiveAdmin(id)) {
    return res.status(400).json({ error: "LAST_ADMIN_RESTRICTION" });
  }

  authService.deleteUser(id);
  if (req.auth?.user?.id === id) {
    clearSessionCookie(res);
  }
  res.json({ ok: true });
});

app.get("/api/admin/stats", (req, res) => {
  if (!ensureAdmin(req, res)) return;
  
  try {
    // Get page view statistics from database
    const stats = authService.query.all(`
      SELECT 
        page_type,
        COUNT(*) as count,
        MAX(timestamp) as last_view
      FROM page_views 
      WHERE timestamp >= datetime('now', '-30 days')
      GROUP BY page_type
      ORDER BY count DESC
    `);
    
    // Format the results
    const pageStats = {};
    let totalViews = 0;
    
    stats.forEach(row => {
      const pageType = row.page_type;
      const count = Number(row.count);
      pageStats[pageType] = {
        count,
        lastView: row.last_view
      };
      totalViews += count;
    });
    
    // Ensure all page types are present with 0 counts if no data
    const allPageTypes = ['index', 'admin', 'login', 'viewer'];
    allPageTypes.forEach(type => {
      if (!pageStats[type]) {
        pageStats[type] = { count: 0, lastView: null };
      }
    });
    
    res.json({
      ok: true,
      stats: pageStats,
      totalViews,
      period: '30 days'
    });
  } catch (err) {
    logError("Failed to get admin stats", err);
    res.status(500).json({ error: "Failed to retrieve statistics" });
  }
});

app.get("/api/admin/stats/details", (req, res) => {
  if (!ensureAdmin(req, res)) return;
  
  try {
    // Get detailed page view events from database (last 30 days, limited to 1000 records)
    const events = authService.query.all(`
      SELECT 
        id,
        page_type,
        timestamp
      FROM page_views 
      WHERE timestamp >= datetime('now', '-30 days')
      ORDER BY timestamp DESC
      LIMIT 1000
    `);
    
    // Format the results
    const formattedEvents = events.map(row => ({
      id: row.id,
      pageType: row.page_type,
      timestamp: row.timestamp,
      // Format timestamp for display
      formattedTime: new Date(row.timestamp).toLocaleString('de-DE', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    }));
    
    res.json({
      ok: true,
      events: formattedEvents,
      totalEvents: formattedEvents.length,
      period: '30 days',
      limit: 1000
    });
  } catch (err) {
    logError("Failed to get admin stats details", err);
    res.status(500).json({ error: "Failed to retrieve statistics details" });
  }
});

app.post("/api/stats/pageview", (req, res) => {
  // This endpoint is public - no authentication required for anonymous tracking
  const { pageType } = req.body || {};
  
  if (!pageType || typeof pageType !== 'string') {
    return res.status(400).json({ error: "pageType is required" });
  }
  
  // Validate page type
  const validTypes = ['index', 'admin', 'login', 'viewer', 'playlist'];
  if (!validTypes.includes(pageType)) {
    return res.status(400).json({ error: "Invalid pageType" });
  }
  
  try {
    // Insert page view record (anonymous - no user_id stored)
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    
    authService.query.run(`
      INSERT INTO page_views (id, page_type, timestamp)
      VALUES (?, ?, ?)
    `, [id, pageType, timestamp]);
    
    res.json({ ok: true });
  } catch (err) {
    logError("Failed to record page view", err, { pageType });
    res.status(500).json({ error: "Failed to record page view" });
  }
});

app.get("/api/playlists", (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { PLAYLIST_STATE } = userContext;
  
  res.setHeader("Cache-Control", "no-store");
  res.json(serializePlaylistState(PLAYLIST_STATE));
});
app.get("/api/playlists/events", (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { PLAYLIST_STATE } = userContext;
  
  // req.auth is set by session middleware
  if (!req.auth || !req.auth.user) {
    return res.status(401).json({ error: "AUTH_REQUIRED" });
  }
  
  const userId = req.auth.user.id;
  console.log('[SSE] New client connecting:', userId, 'IP:', req.ip);
  
  // SSE headers - critical for proxy compatibility
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
  res.setHeader("Access-Control-Allow-Origin", "*"); // Allow cross-origin for SSE
  res.setHeader("Access-Control-Allow-Headers", "Cache-Control");
  res.flushHeaders();
  console.log('[SSE] Headers sent, flushed');
  
  // Send an immediate comment to establish connection
  res.write(': SSE connection established\n\n');
  if (typeof res.flush === 'function') {
    res.flush();
  }
  console.log('[SSE] Connection establishment comment sent');

  // Send initial data
  try {
    const initialData = serializePlaylistState(PLAYLIST_STATE);
    const message = `event: playlist-state\ndata: ${JSON.stringify(initialData)}\n\n`;
    res.write(message);
    
    // Force flush to ensure data reaches client immediately
    if (typeof res.flush === 'function') {
      res.flush();
    }
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }
    
    console.log('[SSE] Initial data sent to', userId, 'Message length:', message.length);
  } catch (err) {
    logError("Failed to send initial playlist state", err);
  }

  // Register with SSE manager
  sseManager.subscribe(userId, "playlist-state", res);
  console.log('[SSE] Client registered:', userId, 'Total subscribers:', sseManager.getSubscriberCount(userId));

  // Keep-alive - more frequent pings for better connection stability
  const keepAlive = setInterval(() => {
    try {
      sseManager.ping(userId, "playlist-state");
    } catch (err) {
      console.warn('[SSE] Keep-alive ping failed:', err.message);
    }
  }, 10000); // Reduced from 15s to 10s for better stability

  // Handle connection close
  req.on("close", () => {
    clearInterval(keepAlive);
    try {
      sseManager.unsubscribe(userId, "playlist-state", res);
      res.end();
    } catch (err) {
      console.warn('[SSE] Error during cleanup:', err.message);
    }
  });

  // Handle connection errors
  req.on("error", (err) => {
    console.warn('[SSE] Request error:', err.message);
    clearInterval(keepAlive);
    try {
      sseManager.unsubscribe(userId, "playlist-state", res);
      res.end();
    } catch {}
  });
});

// Legacy active playlist endpoints (kept for backwards compatibility)
app.get("/api/playlist", (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  res.setHeader("Cache-Control", "no-store");
  res.json(serializeActivePlaylist());
});
app.get("/api/playlist/events", (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  // req.auth is set by session middleware
  if (!req.auth || !req.auth.user) {
    return res.status(401).json({ error: "AUTH_REQUIRED" });
  }
  
  const userId = req.auth.user.id;
  
  // SSE headers - critical for proxy compatibility
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
  res.setHeader("Access-Control-Allow-Origin", "*"); // Allow cross-origin for SSE
  res.setHeader("Access-Control-Allow-Headers", "Cache-Control");
  res.flushHeaders();

  // Send initial data immediately
  try {
    const initialData = `event: playlist-active\ndata: ${JSON.stringify(serializeActivePlaylist())}\n\n`;
    res.write(initialData);
  } catch (err) {
    logError("Failed to send initial active playlist", err);
  }

  // Register with SSE manager
  sseManager.subscribe(userId, "playlist-active", res);
  console.log('[SSE] Client registered:', userId, 'Total subscribers:', sseManager.getSubscriberCount(userId));

  // Keep-alive - more frequent pings for better connection stability
  const keepAlive = setInterval(() => {
    try {
      sseManager.ping(userId, "playlist-active");
    } catch (err) {
      console.warn('[SSE] Keep-alive ping failed:', err.message);
    }
  }, 10000); // Reduced from 15s to 10s for better stability

  // Handle connection close
  req.on("close", () => {
    clearInterval(keepAlive);
    try {
      sseManager.unsubscribe(userId, "playlist-active", res);
      res.end();
    } catch (err) {
      console.warn('[SSE] Error during cleanup:', err.message);
    }
  });

  // Handle connection errors
  req.on("error", (err) => {
    console.warn('[SSE] Request error:', err.message);
    clearInterval(keepAlive);
    try {
      sseManager.unsubscribe(userId, "playlist-active", res);
      res.end();
    } catch {}
  });
});

app.post("/api/playlists", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { PLAYLIST_STATE } = userContext;
  
  const { name, icon, accentColor, items } = req.body || {};
  ensureActivePlaylistPresent();
  const playlist = createPlaylist({
    name: sanitizePlaylistName(name, buildDefaultPlaylistName()),
    icon,
    accentColor,
    items
  }, { paletteIndex: PLAYLIST_STATE.playlists.length });
  PLAYLIST_STATE.playlists.push(playlist);
  PLAYLIST_STATE.activeId = playlist.id;
  updatePlaylistTimestamp(playlist);
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists(req.auth?.user?.id);
  res.status(201).json({ ok: true, playlist: clonePlaylist(playlist), state: serializePlaylistState(PLAYLIST_STATE) });
});

app.post("/api/playlists/:id/activate", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { PLAYLIST_STATE } = userContext;
  
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  PLAYLIST_STATE.activeId = playlist.id;
  PLAYLIST_STATE.updatedAt = Date.now();
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists(req.auth?.user?.id);
  res.json({ ok: true, state: serializePlaylistState(PLAYLIST_STATE) });
});

app.patch("/api/playlists/:id", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  const { name, icon, accentColor, currentIndex } = req.body || {};
  if (name !== undefined) playlist.name = sanitizePlaylistName(name, playlist.name);
  if (icon !== undefined) playlist.icon = sanitizePlaylistIcon(icon);
  if (accentColor !== undefined) playlist.accentColor = sanitizeAccentColor(accentColor);
  if (currentIndex !== undefined && Number.isInteger(currentIndex)) {
    playlist.currentIndex = Math.max(-1, Math.min(playlist.items.length - 1, currentIndex));
  }
  updatePlaylistTimestamp(playlist);
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists(req.auth?.user?.id);
  res.json({ ok: true, playlist: clonePlaylist(playlist) });
});

app.delete("/api/playlists/:id", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { PLAYLIST_STATE } = userContext;
  
  const { id } = req.params;
  if (!removePlaylistById(id)) {
    return res.status(404).json({ error: "Playlist not found" });
  }
  ensureActivePlaylistPresent();
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists(req.auth?.user?.id);
  res.json({ ok: true, state: serializePlaylistState(PLAYLIST_STATE) });
});

app.post("/api/playlists/:id/items/add", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  const { name } = req.body || {};
  const rel = normalizeRelName(name);
  if (!rel) return res.status(400).json({ error: "Invalid file name" });
  const changed = addItemToPlaylist(playlist, rel);
  if (changed) {
    await savePlaylistsImmediate().catch(() => {});
    broadcastPlaylists(req.auth?.user?.id);
  }
  res.json({ ok: true, playlist: clonePlaylist(playlist) });
});

app.post("/api/playlists/:id/items/remove", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  const { name } = req.body || {};
  const rel = normalizeRelName(name);
  if (!rel) return res.status(400).json({ error: "Invalid file name" });
  const changed = removeItemFromPlaylist(playlist, rel);
  if (changed) {
    await savePlaylistsImmediate().catch(() => {});
    broadcastPlaylists(req.auth?.user?.id);
  }
  res.json({ ok: true, playlist: clonePlaylist(playlist) });
});

app.post("/api/playlists/:id/items/clear", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  const changed = clearPlaylistItems(playlist);
  if (changed) {
    await savePlaylistsImmediate().catch(() => {});
    broadcastPlaylists(req.auth?.user?.id);
  }
  res.json({ ok: true, playlist: clonePlaylist(playlist) });
});

app.post("/api/playlists/:id/items/reorder", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: "order must be an array" });
  const normalized = order.map((name) => normalizeRelName(name)).filter(Boolean);
  reorderPlaylistItems(playlist, normalized);
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists(req.auth?.user?.id);
  res.json({ ok: true, playlist: clonePlaylist(playlist) });
});

app.post("/api/playlists/:id/items/set", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  const { items, currentIndex } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "items must be an array" });
  const normalized = items.map((name) => normalizeRelName(name)).filter(Boolean);
  setPlaylistItems(playlist, normalized, currentIndex);
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists(req.auth?.user?.id);
  res.json({ ok: true, playlist: clonePlaylist(playlist) });
});

app.post("/api/playlists/:id/items/current", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  const { index } = req.body || {};
  if (!Number.isInteger(index)) return res.status(400).json({ error: "index must be integer" });
  setPlaylistCurrentIndex(playlist, index);
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists(req.auth?.user?.id);
  res.json({ ok: true, playlist: clonePlaylist(playlist) });
});

app.post("/api/playlists/items/assign", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { PLAYLIST_STATE, USER_DOCUMENTS } = userContext;
  
  const { name, playlists } = req.body || {};
  
  if (!name || typeof name !== 'string') {
    console.warn('[SECURITY] Invalid name in playlist assign:', typeof name);
    return res.status(400).json({ error: "Invalid or missing file name" });
  }
  
  // SECURITY FIX: Use resolvePdfName for proper path validation
  // This prevents path traversal attacks (../, absolute paths, etc.)
  const info = resolvePdfName(name, { requireExists: false });
  if (!info) {
    console.warn('[SECURITY] Path traversal attempt blocked in playlist assign:', name);
    return res.status(400).json({ error: "Invalid file name" });
  }
  
  const rel = info.rel; // Sanitized and validated path
  
  // SECURITY: Check if user has access to this document
  if (!USER_DOCUMENTS.has(rel)) {
    console.warn('[SECURITY] Unauthorized playlist assign attempt:', {
      userId: req.auth.user.id.substring(0, 8),
      file: rel
    });
    return res.status(403).json({ error: "Access denied to this document" });
  }
  
  const ids = Array.isArray(playlists) ? playlists.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean) : [];
  
  if (ids.length === 0) {
    console.warn('No valid playlist IDs provided');
    return res.status(400).json({ error: "No playlists selected" });
  }
  
  const targetSet = new Set(ids);
  let changed = false;

  PLAYLIST_STATE.playlists.forEach((pl) => {
    const has = pl.items.includes(rel);
    const shouldHave = targetSet.has(pl.id);
    if (shouldHave && !has) {
      pl.items.push(rel);
      updatePlaylistTimestamp(pl);
      changed = true;
    } else if (!shouldHave && has) {
      pl.items = pl.items.filter((item) => item !== rel);
      if (pl.currentIndex >= pl.items.length) {
        pl.currentIndex = pl.items.length ? pl.items.length - 1 : -1;
      }
      updatePlaylistTimestamp(pl);
      changed = true;
    }
  });

  if (changed) {
    await savePlaylistsImmediate().catch((err) => {
      logError('Failed to save playlists', err);
    });
    broadcastPlaylists(req.auth?.user?.id);
  }

  res.json({ ok: true, state: serializePlaylistState(PLAYLIST_STATE) });
});

// Legacy convenience endpoints targeting the active playlist
app.post("/api/playlist/add", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const active = ensureActivePlaylistPresent();
  const { name } = req.body || {};
  const rel = normalizeRelName(name);
  if (!rel) return res.status(400).json({ error: "Invalid file name" });
  const changed = addItemToPlaylist(active, rel);
  if (changed) {
    await savePlaylistsImmediate().catch(() => {});
    broadcastPlaylists(req.auth?.user?.id);
  }
  res.json({ ok: true, playlist: serializeActivePlaylist() });
});
app.post("/api/playlist/remove", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const active = ensureActivePlaylistPresent();
  const { name } = req.body || {};
  const rel = normalizeRelName(name);
  if (!rel) return res.status(400).json({ error: "Invalid file name" });
  const changed = removeItemFromPlaylist(active, rel);
  if (changed) {
    await savePlaylistsImmediate().catch(() => {});
    broadcastPlaylists(req.auth?.user?.id);
  }
  res.json({ ok: true, playlist: serializeActivePlaylist() });
});
app.post("/api/playlist/clear", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const active = ensureActivePlaylistPresent();
  const changed = clearPlaylistItems(active);
  if (changed) {
    await savePlaylistsImmediate().catch(() => {});
    broadcastPlaylists(req.auth?.user?.id);
  }
  res.json({ ok: true, playlist: serializeActivePlaylist() });
});
app.post("/api/playlist/reorder", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const active = ensureActivePlaylistPresent();
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: "order must be an array" });
  const normalized = order.map((name) => normalizeRelName(name)).filter(Boolean);
  reorderPlaylistItems(active, normalized);
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists(req.auth?.user?.id);
  res.json({ ok: true, playlist: serializeActivePlaylist() });
});
app.post("/api/playlist", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const active = ensureActivePlaylistPresent();
  const { items, currentIndex, name } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "items must be an array" });
  if (name !== undefined) active.name = sanitizePlaylistName(name, active.name);
  const normalized = items.map((item) => normalizeRelName(item)).filter(Boolean);
  setPlaylistItems(active, normalized, currentIndex);
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists(req.auth?.user?.id);
  res.json({ ok: true, playlist: serializeActivePlaylist() });
});
app.post("/api/playlist/current", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const active = ensureActivePlaylistPresent();
  const { index } = req.body || {};
  if (!Number.isInteger(index)) return res.status(400).json({ error: "index must be integer" });
  setPlaylistCurrentIndex(active, index);
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists(req.auth?.user?.id);
  res.json({ ok: true, playlist: serializeActivePlaylist() });
});

function isValidPdfName(name) {
  return Boolean(resolvePdfName(name));
}

/* ---------------- App-level middlewares (optimized) ---------------- */
if (helmet) {
  app.use(helmet({
    // SECURITY: Stricter Content Security Policy
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'", // Required for inline module scripts in index.html
          "'unsafe-eval'", // Required for PDF.js worker
          "blob:", // Required for PDF.js blob workers
          "https://cdn.tailwindcss.com", // Tailwind CSS CDN
        ],
        styleSrc: ["'self'", "'unsafe-inline'"], // inline styles in HTML
        imgSrc: ["'self'", "data:", "blob:"], // PDF thumbnails use data URLs
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"], // SSE connections
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
        workerSrc: ["'self'", "blob:"], // PDF.js workers
        childSrc: ["'self'", "blob:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"], // Prevent clickjacking
        baseUri: ["'self'"],
        upgradeInsecureRequests: [], // Force HTTPS in production
      },
    },
    crossOriginEmbedderPolicy: false, // Required for PDF.js SharedArrayBuffer
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    dnsPrefetchControl: { allow: false },
    frameguard: { action: "deny" },
    hidePoweredBy: true,
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    ieNoOpen: true,
    noSniff: true,
    originAgentCluster: true,
    permittedCrossDomainPolicies: { permittedPolicies: "none" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    xssFilter: true,
  }));
  console.log('[SECURITY] Helmet security headers enabled with strict CSP');
} else {
  console.warn('[SECURITY] Helmet not installed - security headers disabled');
}

function isSseRequest(req) {
  if (!req) return false;
  const accept = req.headers?.accept || "";
  if (accept.includes("text/event-stream")) return true;
  const reqPath = req.path || req.url || "";
  return SSE_EVENT_PATHS.some((route) => reqPath.startsWith(route));
}

if (compression && MEMORY_SETTINGS.enableGzipCompression) {
  app.use(compression({
    level: 6, // Balanced compression level
    threshold: 1024, // Only compress files > 1KB
    filter: (req, res) => {
      // Don't compress PDFs or already compressed content
      if (req.path?.startsWith('/sheets/')) return false;
      if (isSseRequest(req)) return false;
      return compression.filter(req, res);
    }
  }));
}

if (morgan) app.use(morgan("tiny"));

// NOTE: express.json() middleware is now placed BEFORE API routes (see line ~1415)

// Add memory monitoring middleware
/* ---------------- Front-end (SPA) ---------------- */

// Middleware to inject BASE_PATH into HTML files
app.use((req, res, next) => {
  // Only handle HTML requests, not API routes
  if (req.path.startsWith('/api/')) {
    return next();
  }
  
  const isHtmlRequest = req.path.endsWith('.html') || 
                        req.path === '/' || 
                        req.path === '/admin' ||
                        req.path === '/login';
  
  if (!isHtmlRequest) {
    return next();
  }
  
  // Determine which HTML file to serve
  let fileName = 'index.html';
  if (req.path === '/admin' || req.path === '/admin.html') {
    fileName = 'admin.html';
  } else if (req.path === '/login' || req.path === '/login.html') {
    fileName = 'login.html';
  } else if (req.path.endsWith('.html')) {
    fileName = path.basename(req.path);
  }
  
  const filePath = path.join(PUBLIC_DIR, fileName);
  
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) {
      console.warn('[HTML Injection] Failed to read:', filePath);
      return next();
    }
    
    // Inject base path as global variable before any other scripts
    const injectedHtml = html.replace(
      /<head>/i,
      `<head>\n    <script>window.__BASE_PATH__ = '${BASE_PATH}';</script>`
    );
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(injectedHtml);
  });
});

app.use(express.static(PUBLIC_DIR, { 
  etag: true, 
  lastModified: true, 
  maxAge: 0, // Disable browser caching for static files
  setHeaders: (res, path) => {
    // Aggressive no-cache for HTML, JS, CSS files
    if (path.endsWith('.html') || path.endsWith('.js') || path.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      // Allow caching for other assets (images, etc.) but with shorter duration
      res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour for images, etc.
    }
  }
}));

/* ---------------- Serve local vendors ---------------- */
app.get(/^\/vendor\/pdfjs\/pdf\.min\.js$/, async (req, res) => {
  try { await ensureVendor("pdfjs/pdf.min.js", VENDORS["pdfjs/pdf.min.js"]); } catch {}
  const dest = path.join(VENDOR_DIR, "pdfjs/pdf.min.js");
  res.setHeader("Content-Type", "application/javascript");
  return fs.createReadStream(dest).pipe(res);
});
app.get(/^\/vendor\/pdfjs\/pdf\.worker\.min\.js$/, async (req, res) => {
  try { await ensureVendor("pdfjs/pdf.worker.min.js", VENDORS["pdfjs/pdf.worker.min.js"]); } catch {}
  const dest = path.join(VENDOR_DIR, "pdfjs/pdf.worker.min.js");
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  return fs.createReadStream(dest).pipe(res);
});
app.get(/^\/vendor\/fuse\.min\.js$/, async (req, res) => {
  try { await ensureVendor("fuse.min.js", VENDORS["fuse.min.js"]); } catch {}
  const dest = path.join(VENDOR_DIR, "fuse.min.js");
  res.setHeader("Content-Type", "application/javascript");
  return fs.createReadStream(dest).pipe(res);
});
app.get(/^\/vendor\/nosleep\.min\.js$/, async (req, res) => {
  try { await ensureVendor("nosleep.min.js", VENDORS["nosleep.min.js"]); } catch {}
  const dest = path.join(VENDOR_DIR, "nosleep.min.js");
  res.setHeader("Content-Type", "application/javascript");
  return fs.createReadStream(dest).pipe(res);
});

/* ---------------- Serve Thumbnails (/thumbnails) ---------------- */
app.get("/thumbnails/*", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { USER_DOCUMENTS } = userContext;
  
  const sendFallback = () => {
    try {
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      res.end(FALLBACK_THUMB_BUFFER);
    } catch (e) {
      try { res.status(500).end(); } catch {}
    }
  };
  try {
    const requested = toPosixPath(req.params[0] || "");
    if (!requested || !/\.(jpg|jpeg|png)$/i.test(requested)) {
      return sendFallback();
    }

    const pdfRel = requested.replace(/\.(jpg|jpeg|png)$/i, ".pdf");
    const info = resolvePdfName(pdfRel);
    if (!info) {
      return sendFallback();
    }
    
    // Check if user has access to this document
    if (!USER_DOCUMENTS.has(info.rel)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const { thumbPath, thumbStat } = await ensureThumbnail(info);
    if (!thumbStat) {
      return sendFallback();
    }

    const etag = `"${thumbStat.size}-${Math.floor(thumbStat.mtimeMs)}"`;
    const lastModified = new Date(thumbStat.mtimeMs).toUTCString();

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.setHeader("ETag", etag);
    res.setHeader("Last-Modified", lastModified);

    const ifNoneMatch = req.headers["if-none-match"];
    const ifModifiedSince = req.headers["if-modified-since"];
    const notModifiedByEtag = ifNoneMatch && ifNoneMatch.split(/\s*,\s*/).includes(etag);
    const notModifiedByDate = ifModifiedSince && new Date(ifModifiedSince).getTime() >= thumbStat.mtimeMs;

    if (notModifiedByEtag || notModifiedByDate) {
      return res.status(304).end();
    }

    const stream = fs.createReadStream(thumbPath);
    stream.on("error", (e) => {
      console.warn("Thumbnail stream error, sending fallback:", e?.message || e);
      if (!res.headersSent) {
        // reset headers for fallback
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "no-store");
      }
      res.end(FALLBACK_THUMB_BUFFER);
    });
    return stream.pipe(res);
  } catch (error) {
    logError("Thumbnail serve error", error, { thumbPath: relPathEncoded });
    return sendFallback();
  }
});

/* ---------------- Serve PDFs (/sheets) - optimized for mobile ---------------- */
// Enhanced Range request handling for better streaming on mobile
app.use("/sheets", (req, res, next) => {
  try {
    const decoded = (() => {
      try { return decodeURIComponent(req.path.replace(/^\/+/, "")); }
      catch { return null; }
    })();
    if (!decoded || !decoded.toLowerCase().endsWith(".pdf")) {
      return next();
    }

    const info = resolvePdfName(decoded);
    if (info) {
      const range = req.headers.range;
      if (range) {
        const st = fs.statSync(info.abs);
        const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
        if (m) {
          const start = Number(m[1]);
          let end = m[2] ? Number(m[2]) : st.size - 1;
          
          // Limit range size to prevent memory issues on large PDFs
          const maxRangeSize = 4 * 1024 * 1024;
          if (end - start > maxRangeSize) {
            end = start + maxRangeSize - 1;
          }
          
          if (!(Number.isFinite(start) && Number.isFinite(end) && start <= end && end < st.size)) {
            delete req.headers.range; // serve full content (200)
          } else {
            // Update range header with clamped end
            req.headers.range = `bytes=${start}-${end}`;
          }
        } else {
          delete req.headers.range;
        }
      }
    }
  } catch {}
  next();
});

app.use(
  "/sheets",
  (req, res, next) => {
    // Check authentication and document access for PDF files
    if (!ensureAuthenticated(req, res)) return;
    
    const { USER_DOCUMENTS } = userContext;
    const requestedPath = decodeURIComponent(req.path);
    
    // Extract relative path (remove leading slash)
    const relPath = requestedPath.startsWith('/') ? requestedPath.slice(1) : requestedPath;
    
    // Check if user has access to this document
    if (!USER_DOCUMENTS.has(relPath)) {
      return res.status(403).json({ error: "Access denied to this document" });
    }
    
    next();
  },
  express.static(SHEETS_DIR, {
    maxAge: 0,
    etag: true,
    lastModified: true,
    dotfiles: 'deny',
    setHeaders(res, filePath) {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      
      // Add content length for better mobile handling
      try {
        const stat = fs.statSync(filePath);
        res.setHeader("Content-Length", stat.size);
      } catch (e) {}
    },
  })
);

/* ---------------- Index + Listing helpers (memory-optimized) ---------------- */
// Note: indexCache, statSafe, scanDir, getIndex, applySort moved to global scope
// to be accessible during server startup and outside registerApiRoutes()

/* ---------------- Memory & System API ---------------- */
app.get("/api/debug/sse-stats", (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const stats = sseManager.getStats();
  res.json({
    stats,
    currentUser: req.auth.user.id,
    currentUserConnections: sseManager.getSubscriberCount(req.auth.user.id)
  });
});

app.post("/api/system/gc", (req, res) => {
  // SECURITY: Use centralized admin check for consistency
  if (!ensureAdmin(req, res)) return;
  
  try {
    if (global.gc) {
      global.gc();
      res.json({ ok: true, message: "Garbage collection triggered" });
    } else {
      res.json({ ok: false, message: "GC not available (start with --expose-gc)" });
    }
  } catch (e) {
    res.status(500).json({ error: "GC failed", details: e.message });
  }
});

app.post("/api/system/cache/clear", (req, res) => {
  // SECURITY: Use centralized admin check for consistency
  if (!ensureAdmin(req, res)) return;
  
  try {
    indexCache = { at: 0, items: [], scanInProgress: false };
    res.json({ ok: true, message: "Cache cleared" });
  } catch (e) {
    res.status(500).json({ error: "Cache clear failed" });
  }
});

function normalizeRelName(name) {
  const info = resolvePdfName(name, { requireExists: false });
  return info ? info.rel : null;
}

// SECURITY: Timeout wrapper to prevent hanging operations
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

function withAnnotationLock(rel, task) {
  const prev = annotationLocks.get(rel) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => {
      // SECURITY FIX: Add 30-second timeout for annotation operations
      return withTimeout(task(), 30000, 'Annotation operation');
    })
    .catch((err) => {
      if (err.message && err.message.includes('timeout')) {
        logError('Annotation operation timeout', err, { rel });
        throw new Error('Operation timeout - file may be too large or complex');
      }
      throw err;
    })
    .finally(() => {
      if (annotationLocks.get(rel) === next) {
        annotationLocks.delete(rel);
      }
    });
  annotationLocks.set(rel, next);
  return next;
}

/* ---------------- Document Sharing API ---------------- */
// Get share info for a document
app.get("/api/share/info", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const fileName = req.query.name;
  if (!fileName) {
    return sendError(res, 400, "Document name required");
  }
  
  const info = resolvePdfName(fileName);
  if (!info) {
    return sendError(res, 404, "Document not found");
  }
  
  try {
    const shareInfo = dataStore.getDocumentShareInfo(info.rel);
    const accessRole = dataStore.getDocumentAccessRole(req.auth.user.id, info.rel);
    
    res.json({
      ...shareInfo,
      accessRole,
      canShare: accessRole === 'owner'
    });
  } catch (err) {
    logError('Get share info failed', err, { fileName, userId: req.auth.user.id });
    sendError(res, 500, 'Fehler beim Abrufen der Freigabe-Informationen', err, 'Get share info');
  }
});

// Batch: Get share info for multiple documents at once (optimized for large libraries)
app.post("/api/share/info/batch", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const { fileNames } = req.body;
  
  if (!Array.isArray(fileNames) || fileNames.length === 0) {
    return sendError(res, 400, "File names array required");
  }
  
  // Limit batch size to prevent abuse
  if (fileNames.length > 200) {
    return sendError(res, 400, "Batch size too large (max 200)");
  }
  
  try {
    const results = {};
    
    for (const fileName of fileNames) {
      const info = resolvePdfName(fileName);
      if (!info) {
        results[fileName] = { error: 'NOT_FOUND', accessRole: null, canShare: false };
        continue;
      }
      
      try {
        const shareInfo = dataStore.getDocumentShareInfo(info.rel);
        const accessRole = dataStore.getDocumentAccessRole(req.auth.user.id, info.rel);
        
        results[fileName] = {
          ...shareInfo,
          accessRole,
          canShare: accessRole === 'owner'
        };
      } catch (err) {
        results[fileName] = { error: 'INTERNAL_ERROR', accessRole: null, canShare: false };
      }
    }
    
    res.json({ results });
  } catch (err) {
    logError('Batch share info failed', err, { userId: req.auth.user.id, count: fileNames.length });
    sendError(res, 500, 'Fehler beim Abrufen der Freigabe-Informationen', err, 'Batch share info');
  }
});

// Share document with other users
app.post("/api/share", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const { fileName, userIds } = req.body;
  
  if (!fileName || !Array.isArray(userIds) || userIds.length === 0) {
    return sendError(res, 400, "Document name and target user IDs required");
  }
  
  const info = resolvePdfName(fileName);
  if (!info) {
    return sendError(res, 404, "Document not found");
  }
  
  try {
    // Verify user is owner
    const accessRole = dataStore.getDocumentAccessRole(req.auth.user.id, info.rel);
    if (accessRole !== 'owner') {
      return sendError(res, 403, "Only document owner can share");
    }
    
    // Validate target user IDs exist
    const validUserIds = [];
    for (const userId of userIds) {
      const user = authService.getUserById(userId);
      if (user && user.isActive) {
        validUserIds.push(userId);
      }
    }
    
    if (validUserIds.length === 0) {
      return sendError(res, 400, "No valid target users found");
    }
    
    dataStore.shareDocument(req.auth.user.id, info.rel, validUserIds);
    
    // Invalidate document cache for target users so they see the new shared document
    for (const targetUserId of validUserIds) {
      userContext.addDocumentsToUserCache(targetUserId, [info.rel]);
    }
    
    // Also invalidate owner's cache so share info updates on page reload
    userContext._caches.userDocumentCache.delete(req.auth.user.id);
    
    res.json({
      success: true,
      sharedWith: validUserIds.length,
      message: `Dokument mit ${validUserIds.length} Benutzer(n) geteilt`
    });
  } catch (err) {
    logError('Share document failed', err, { fileName, userIds, userId: req.auth.user.id });
    sendError(res, 500, err.message || 'Fehler beim Teilen des Dokuments', err, 'Share document');
  }
});

// Unshare document from specific users
app.delete("/api/share", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const { fileName, userIds } = req.body;
  
  if (!fileName) {
    return sendError(res, 400, "Document name required");
  }
  
  const info = resolvePdfName(fileName);
  if (!info) {
    return sendError(res, 404, "Document not found");
  }
  
  try {
    const accessRole = dataStore.getDocumentAccessRole(req.auth.user.id, info.rel);
    
    // Owner can unshare from others, shared users can remove themselves
    if (accessRole === 'owner' && Array.isArray(userIds) && userIds.length > 0) {
      dataStore.unshareDocument(req.auth.user.id, info.rel, userIds);
      
      // Update document cache for target users - remove the document
      for (const targetUserId of userIds) {
        const store = userContext._caches.userDocumentCache.get(targetUserId);
        if (store) {
          store.delete(info.rel);
        }
      }
      
      // Also invalidate owner's cache so share info updates on page reload
      userContext._caches.userDocumentCache.delete(req.auth.user.id);
      
      res.json({
        success: true,
        message: `Freigabe für ${userIds.length} Benutzer(n) aufgehoben`
      });
    } else if (accessRole === 'shared') {
      dataStore.removeSelfFromSharedDocument(req.auth.user.id, info.rel);
      
      // Update own document cache - remove the document
      const store = userContext._caches.userDocumentCache.get(req.auth.user.id);
      if (store) {
        store.delete(info.rel);
      }
      
      res.json({
        success: true,
        message: 'Dokument von Ihrer Bibliothek entfernt'
      });
    } else {
      return sendError(res, 403, "No permission to modify sharing");
    }
  } catch (err) {
    logError('Unshare document failed', err, { fileName, userIds, userId: req.auth.user.id });
    sendError(res, 500, 'Fehler beim Aufheben der Freigabe', err, 'Unshare document');
  }
});

// Get user's share code (their user ID)
app.get("/api/share/code", (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  res.json({
    userId: req.auth.user.id,
    email: req.auth.user.email
  });
});

// Get list of all users (for sharing UI) - limited info
app.get("/api/users/list", (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  try {
    const users = authService.listUsers()
      .filter(u => u.isActive && u.id !== req.auth.user.id)
      .map(u => ({
        id: u.id,
        email: u.email
      }));
    
    res.json({ users });
  } catch (err) {
    logError('List users failed', err, { userId: req.auth.user.id });
    sendError(res, 500, 'Fehler beim Abrufen der Benutzerliste', err, 'List users');
  }
});

/* ---------------- Sheets API (enhanced with pagination) ---------------- */
app.get("/api/sheets", async (req, res) => {
  try {
    if (!ensureAuthenticated(req, res)) return;
    const { CONFIG, USER_DOCUMENTS } = userContext;
    
    const q = (req.query.q || "").toString().trim().toLowerCase();
    const sort = (req.query.sort || "name").toString();
    const order = (req.query.order || "asc").toString();
    const categoryParam = req.query.category ?? req.query.categories;

    // Support special filter "none" to select uncategorized files
    let wantUncategorized = false;
    const categoryFilters = (() => {
      if (!categoryParam) return [];
      const raw = Array.isArray(categoryParam) ? categoryParam : [categoryParam];
      const parts = raw
        .flatMap((value) => value.toString().split(/[,;\s]+/))
        .map((value) => value.trim())
        .filter(Boolean);
      // Detect special token(s)
      for (const p of parts) {
        if (p.toLowerCase() === "none") {
          wantUncategorized = true;
        }
      }
      // Remove special tokens and sanitize valid IDs
      const idsOnly = parts.filter((p) => p.toLowerCase() !== "none");
      return sanitizeCategoryIds(idsOnly);
    })();
    const categoryFilterSet = new Set(categoryFilters);

    // Allow pageSize=all to return everything in one call
    let page = Math.max(1, parseInt(req.query.page || "1", 10));
    const psRaw = (req.query.pageSize ?? "60").toString().toLowerCase();
    let pageSize;
    if (psRaw === "all" || psRaw === "*") {
      pageSize = Number.MAX_SAFE_INTEGER; // return all items
      page = 1;
    } else {
      const parsed = parseInt(psRaw, 10);
      // Reduce max page size for memory efficiency
      pageSize = Math.min(200, Math.max(1, Number.isFinite(parsed) ? parsed : 60));
    }

    const favParam = (req.query.fav || "0").toString().toLowerCase();
    const onlyFav = favParam === "1" || favParam === "true";

    const all = await getIndex();
    
    // Filter by user's accessible documents and add user-specific category info
    // USER_DOCUMENTS is a Proxy that wraps a Set, use it directly
    // De-duplicate by name to prevent showing the same document multiple times
    const seenNames = new Set();
    let filtered = all
      .filter(x => {
        if (!USER_DOCUMENTS.has(x.name)) return false;
        if (seenNames.has(x.name)) return false; // Skip duplicates
        seenNames.add(x.name);
        return true;
      })
      .map(item => {
        // Add user-specific category information
        const fileCfg = CONFIG.files[item.name] || {};
        const catIds = sanitizeCategoryIds(fileCfg.categories || []);
        const categoriesDetailed = catIds
          .map((id) => {
            const cat = getCategoryById(id);
            return cat ? { ...cat } : null;
          })
          .filter(Boolean);
        
        return {
          ...item,
          categoryIds: catIds,
          categories: categoriesDetailed,
        };
      });

    if (onlyFav) {
      const favSet = new Set(CONFIG.favorites);
      filtered = filtered.filter(x => favSet.has(x.name));
    }
    if (q) {
      filtered = filtered.filter(x => x.name.toLowerCase().includes(q));
    }
    if (wantUncategorized && categoryFilterSet.size === 0) {
      // Only uncategorized requested
      filtered = filtered.filter((item) => {
        return !(item && Array.isArray(item.categoryIds) && item.categoryIds.length);
      });
    } else if (categoryFilterSet.size) {
      // Filter by provided categories
      filtered = filtered.filter((item) => {
        if (!item || !Array.isArray(item.categoryIds)) return false;
        return item.categoryIds.some((id) => categoryFilterSet.has(id));
      });
    }

    const sorted = applySort(filtered, sort, order);
    const total = sorted.length;
    const start = (page - 1) * pageSize;
    const items = sorted.slice(start, start + pageSize);

    res.setHeader("Cache-Control", "no-store");
    res.json({ 
      items, 
      total, 
      page, 
      pageSize: psRaw === "all" ? "all" : pageSize,
  categories: CONFIG.categories.map((cat) => ({ ...cat })),
  activeCategories: Array.from(categoryFilterSet),
  activeUncategorized: wantUncategorized && categoryFilterSet.size === 0,
      serverMemory: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        cacheSize: indexCache.items.length
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list sheets." });
  }
});

// Improved upload endpoint (accepts PDF by MIME or .pdf filename)
app.post("/api/upload", uploadLimiter || ((req, res, next) => next()), async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const limitMb = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);
  const contentType = ((req.headers["content-type"] || "").toString().toLowerCase());
  const metaHeader = decodeUploadHeader(req.headers["x-upload-meta"]);
  let meta = {};
  if (metaHeader) {
    try {
      meta = JSON.parse(metaHeader);
    } catch {
      return res.status(400).json({ error: "Ungültige Upload-Metadaten" });
    }
  }
  if (!meta || typeof meta !== "object") meta = {};

  const headerName = decodeUploadHeader(req.headers["x-upload-name"]).trim();
  const metaOriginal = typeof meta.originalName === "string" ? meta.originalName.trim() : "";
  const declaredName = headerName || metaOriginal;

  const isPdfByMime = contentType.includes("application/pdf") || contentType.includes("application/octet-stream");
  const isPdfByName = declaredName.toLowerCase().endsWith(".pdf");
  if (!isPdfByMime && !isPdfByName) {
    return res.status(415).json({ error: "Nur PDF-Dateien erlaubt (fehlender PDF Content-Type und Dateiendung)" });
  }

  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: `Datei ist größer als ${limitMb} MB.` });
  }

  const rawName = (meta.originalName && typeof meta.originalName === "string")
    ? meta.originalName.trim()
    : (typeof req.headers["x-upload-name"] === "string" ? req.headers["x-upload-name"].trim() : "upload.pdf");
  
  // SECURITY: Validate filename against path traversal
  if (rawName.includes('..') || rawName.includes('/') || rawName.includes('\\') || rawName.includes('\0')) {
    console.warn('[SECURITY] Path traversal in upload filename blocked:', rawName);
    return res.status(400).json({ error: "Ungültiger Dateiname" });
  }
  
  const baseName = path.basename(rawName || "upload", path.extname(rawName || "") || ".pdf");
  const finalName = generateUniquePdfFilename(baseName || "sheet");
  
  // SECURITY: Additional check - finalName must be a simple filename without path separators
  if (finalName.includes('/') || finalName.includes('\\') || finalName.includes('..')) {
    console.error('[SECURITY] Generated filename contains path separators:', finalName);
    return res.status(500).json({ error: "Interner Fehler bei Dateinamen-Generierung" });
  }
  
  const finalPath = path.join(SHEETS_DIR, finalName);
  const rel = toPosixPath(finalName);
  const tempName = `.${Date.now()}-${Math.round(Math.random() * 1e6)}-${finalName}`;
  const tempPath = path.join(SHEETS_DIR, tempName);

  try {
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
  } catch (err) {
    return sendError(res, 500, "Upload konnte nicht vorbereitet werden", err, "Upload mkdir");
  }

  try {
    const limiter = new SizeLimiter(MAX_UPLOAD_BYTES);
    const out = fs.createWriteStream(tempPath);
    await pipeline(req, limiter, out);
  } catch (err) {
    await fs.promises.unlink(tempPath).catch(() => {});
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `Datei ist größer als ${limitMb} MB.` });
    }
    return sendError(res, 400, "Upload fehlgeschlagen", err, "Upload stream");
  }

  try {
    await fs.promises.rename(tempPath, finalPath);
  } catch (err) {
    await fs.promises.unlink(tempPath).catch(() => {});
    return sendError(res, 500, "Upload konnte nicht gespeichert werden", err, "Upload rename");
  }

  const cleanupFile = async () => {
    await fs.promises.unlink(finalPath).catch(() => {});
    const thumbPath = path.join(THUMBS_DIR, thumbnailRelPath(rel));
    await fs.promises.unlink(thumbPath).catch(() => {});
  };
  
  // SECURITY: Validate actual file content (MIME type detection)
  try {
    // Read first chunk of file for MIME detection (more reliable than headers)
    const fileBuffer = await fs.promises.readFile(finalPath);
    
    // Check 1: File-type based MIME detection (if available)
    let detectedMime = null;
    try {
      const { fileTypeFromBuffer } = require('file-type');
      const fileType = await fileTypeFromBuffer(fileBuffer);
      detectedMime = fileType?.mime;
      
      if (fileType && fileType.mime !== 'application/pdf') {
        console.warn('[SECURITY] File upload blocked - wrong MIME type detected:', {
          declared: contentType,
          detected: fileType.mime,
          file: finalName
        });
        await cleanupFile();
        return res.status(415).json({ 
          error: "Nur PDF-Dateien erlaubt",
          details: `Detektierter Dateityp: ${fileType.mime}` 
        });
      }
    } catch (fileTypeErr) {
      // file-type not installed - fallback to PDF signature check
      console.warn('[SECURITY] file-type not available, using fallback validation');
    }
    
    // Check 2: PDF signature validation (magic bytes)
    const pdfSignature = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
    if (!fileBuffer.subarray(0, 4).equals(pdfSignature)) {
      console.warn('[SECURITY] File upload blocked - invalid PDF signature:', finalName);
      await cleanupFile();
      return res.status(415).json({ 
        error: "Ungültige PDF-Datei",
        details: "Datei beginnt nicht mit PDF-Signatur" 
      });
    }
    
    // Check 2b: PDF EOF marker check (prevents polyglot attacks)
    const eofMarker = Buffer.from('%%EOF');
    const lastChunk = fileBuffer.subarray(Math.max(0, fileBuffer.length - 1024));
    if (!lastChunk.includes(eofMarker)) {
      console.warn('[SECURITY] File upload blocked - missing PDF EOF marker:', finalName);
      await cleanupFile();
      return res.status(415).json({ 
        error: "Ungültige PDF-Datei",
        details: "PDF EOF-Marker fehlt (potentielle Polyglot-Datei)" 
      });
    }
    
    // Check 3: Compression ratio check (prevents ZIP bombs)
    const originalSize = fileBuffer.length;
    const MAX_COMPRESSION_RATIO = 100; // Max 100x expansion
    try {
      const zlib = require('zlib');
      const decompressed = zlib.inflateSync(fileBuffer.subarray(0, Math.min(originalSize, 10 * 1024 * 1024)));
      const ratio = decompressed.length / originalSize;
      
      if (ratio > MAX_COMPRESSION_RATIO) {
        console.warn('[SECURITY] File upload blocked - suspicious compression ratio:', {
          file: finalName,
          ratio: ratio.toFixed(2),
          originalSize,
          decompressedSize: decompressed.length
        });
        await cleanupFile();
        return res.status(400).json({ 
          error: "Verdächtige Datei",
          details: "Komprimierungsverhältnis zu hoch (potentielle ZIP-Bomb)"
        });
      }
    } catch (zlibErr) {
      // Not a compressed stream - normal for most PDFs
    }
    
    // Check 4: PDF structure validation using pdf-lib
    try {
      await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
      console.log('[SECURITY] PDF validation passed:', finalName);
    } catch (pdfErr) {
      console.warn('[SECURITY] File upload blocked - corrupt PDF:', {
        file: finalName,
        error: pdfErr.message
      });
      await cleanupFile();
      return res.status(400).json({ 
        error: "Ungültige oder beschädigte PDF-Datei",
        details: "PDF-Struktur konnte nicht gelesen werden"
      });
    }
  } catch (validationErr) {
    await cleanupFile();
    return sendError(res, 500, "Datei-Validierung fehlgeschlagen", validationErr, "File content validation");
  }

  try {
    const { CONFIG } = userContext;
    const categoryIds = sanitizeCategoryIds(Array.isArray(meta.categories) ? meta.categories : []);

    let secsPerPage = null;
    if (meta.secsPerPage !== undefined && meta.secsPerPage !== null && meta.secsPerPage !== "") {
      const v = Number(meta.secsPerPage);
      if (!Number.isFinite(v) || v < 5 || v > 600) {
        await cleanupFile();
        return res.status(400).json({ error: "secsPerPage out of range (5..600)" });
      }
      secsPerPage = Math.round(v);
    }

    const favorite = typeof meta.favorite === "string"
      ? ["true", "1", "on", "yes"].includes(meta.favorite.toLowerCase())
      : Boolean(meta.favorite);

    const st = await statSafe(finalPath);
    if (!st) {
      await cleanupFile();
      return res.status(500).json({ error: "Uploaded file unavailable" });
    }

    // Generate thumbnail synchronously to ensure it's ready or fallback exists
    try {
      await ensureThumbnail({ rel, abs: finalPath });
    } catch (thumbErr) {
      logError("Thumbnail generation failed for upload", thumbErr, { rel });
    }

    const fileConfig = {};
    if (categoryIds.length) fileConfig.categories = categoryIds;
    if (secsPerPage) fileConfig.secsPerPage = secsPerPage;

    if (Object.keys(fileConfig).length) {
      CONFIG.files[rel] = fileConfig;
    } else {
      delete CONFIG.files[rel];
    }

    if (favorite) {
      const favSet = new Set(CONFIG.favorites);
      favSet.add(rel);
      CONFIG.favorites = Array.from(favSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    }

    userContext.markConfigDirty();
    try {
      await userContext.saveConfigImmediate();
    } catch (saveErr) {
      logError("Failed to persist config after upload", saveErr);
    }
    
    // Register document ownership
    try {
      const userId = req.auth.user.id;
      await dataStore.assignDocumentsToUser(userId, [rel], "owner");
      userContext.addDocumentsToUserCache(userId, [rel]);
    } catch (err) {
      logError("Failed to register document", err, { rel, userId: req.auth.user.id });
      // Continue - file is uploaded, just not registered
    }

    const categoriesDetailed = categoryIds
      .map((id) => {
        const cat = getCategoryById(id);
        return cat ? { ...cat } : null;
      })
      .filter(Boolean);

    const encodedRel = encodePathSegments(rel);
    const encodedThumb = encodePathSegments(thumbnailRelPath(rel));
    const item = {
      id: encodeURIComponent(rel),
      name: rel,
      displayName: path.basename(rel),
      folder: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
      url: `/sheets/${encodedRel}`,
      thumbnail: `/thumbnails/${encodedThumb}`,
      size: st.size,
      mtime: st.mtimeMs,
      categoryIds,
      categories: categoriesDetailed,
    };

    const merged = indexCache.items.filter((entry) => entry && entry.name !== rel);
    merged.push(item);
    indexCache.items = applySort(merged, "name", "asc");
    indexCache.at = Date.now();
    refreshIndexCategoriesForFile(rel);

    res.status(201).json({ ok: true, item, favorites: CONFIG.favorites, maxUploadBytes: MAX_UPLOAD_BYTES });
  } catch (err) {
    console.error("Upload processing failed:", err);
    await cleanupFile();
    res.status(500).json({ error: "Upload failed" });
  }
});

/* ---------------- Config API (favorites + per-file secsPerPage) ---------------- */
app.get("/api/prefs", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const store = userContext.requireUserContext();
  const config = store.configEntry.config;
  res.setHeader("Cache-Control", "no-store");
  res.json(config);
});

app.post("/api/prefs/favorites", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { CONFIG } = userContext;
  const { name, favorite } = req.body || {};
  const info = resolvePdfName(name);
  if (!info) return res.status(400).json({ error: "Invalid file name" });
  
  const originalFavorites = [...CONFIG.favorites];
  const set = new Set(CONFIG.favorites);
  if (favorite) set.add(info.rel); else set.delete(info.rel);
  CONFIG.favorites = Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  
  try {
    await userContext.persistConfigNow();
  } catch (err) {
    CONFIG.favorites = originalFavorites;
    console.error("Failed to persist favorites:", err);
    return res.status(500).json({ error: "Failed to persist favorites" });
  }
  res.json({ ok: true, favorites: CONFIG.favorites });
});

app.get("/api/prefs/file", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { CONFIG } = userContext;
  const name = (req.query.name || "").toString();
  const info = resolvePdfName(name, { requireExists: false });
  if (!info) return res.status(400).json({ error: "Invalid file name" });
  const entry = CONFIG.files[info.rel] || {};
  const categoryIds = sanitizeCategoryIds(entry.categories || []);
  const categories = categoryIds
    .map((id) => {
      const cat = getCategoryById(id);
      return cat ? { ...cat } : null;
    })
    .filter(Boolean);
  const jumpMarkers = Array.isArray(entry.jumpMarkers) ? entry.jumpMarkers : [];
  res.json({ name: info.rel, secsPerPage: entry.secsPerPage || null, categories, categoryIds, jumpMarkers });
});

app.post("/api/prefs/file", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { CONFIG } = userContext;
  const { name, secsPerPage, categories, jumpMarkers } = req.body || {};
  const info = resolvePdfName(name);
  if (!info) return res.status(400).json({ error: "Invalid file name" });

  const current = { ...(CONFIG.files[info.rel] || {}) };

  if (secsPerPage !== undefined) {
    const v = Number(secsPerPage);
    if (!Number.isFinite(v) || v < 5 || v > 600) {
      return res.status(400).json({ error: "secsPerPage out of range (5..600)" });
    }
    current.secsPerPage = v;
  }

  if (categories !== undefined) {
    const sanitized = sanitizeCategoryIds(Array.isArray(categories) ? categories : []);
    if (sanitized.length) current.categories = sanitized;
    else delete current.categories;
  }

  // Validate and store jump markers
  if (jumpMarkers !== undefined) {
    if (!Array.isArray(jumpMarkers)) {
      return res.status(400).json({ error: "jumpMarkers must be an array" });
    }
    const validated = sanitizeJumpMarkers(jumpMarkers);
    if (validated.length) current.jumpMarkers = validated;
    else delete current.jumpMarkers;
  }

  // Save original for rollback
  const originalEntry = CONFIG.files[info.rel] ? { ...CONFIG.files[info.rel] } : null;
  const hadEntry = info.rel in CONFIG.files;

  if (Object.keys(current).length) {
    CONFIG.files[info.rel] = current;
  } else {
    delete CONFIG.files[info.rel];
  }

  try {
    await userContext.persistConfigNow();
  } catch (err) {
    // Rollback
    if (hadEntry && originalEntry) {
      CONFIG.files[info.rel] = originalEntry;
    } else {
      delete CONFIG.files[info.rel];
    }
    console.error("Failed to persist file preferences:", err);
    return res.status(500).json({ error: "Failed to persist file preferences" });
  }
  refreshIndexCategoriesForFile(info.rel);

  const latestEntry = CONFIG.files[info.rel] || {};
  const categoryIds = sanitizeCategoryIds(latestEntry.categories || []);
  const categoriesMeta = categoryIds
    .map((id) => {
      const cat = getCategoryById(id);
      return cat ? { ...cat } : null;
    })
    .filter(Boolean);
  const latestMarkers = Array.isArray(latestEntry.jumpMarkers) ? latestEntry.jumpMarkers : [];
  const stat = await statSafe(info.abs);
  res.json({ 
    ok: true, 
    name: info.rel, 
    secsPerPage: latestEntry.secsPerPage || null, 
    categories: categoriesMeta, 
    categoryIds,
    jumpMarkers: latestMarkers,
    mtime: stat ? stat.mtimeMs : null,
    size: stat ? stat.size : null
  });
});

app.get("/api/annotations", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { USER_DOCUMENTS } = userContext;
  
  const name = (req.query.name || "").toString();
  const info = resolvePdfName(name);
  if (!info) {
    return res.status(400).json({ error: "Invalid file name" });
  }
  
  // Check if user has access to this document
  if (!USER_DOCUMENTS.has(info.rel)) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    await ensureAnnotationStore(info.rel);
    const index = await loadAnnotationIndex(info.rel);
    const pages = await serializeAnnotationPages(info, index);
    let historyEntries = [];
    try {
      historyEntries = await listAnnotationSnapshots(info.rel);
    } catch {}
    const st = await statSafe(info.abs);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      name: info.rel,
      pages,
      history: {
        available: historyEntries.length > 0,
        total: historyEntries.length,
      },
      mtime: st ? st.mtimeMs : null,
      size: st ? st.size : null,
    });
  } catch (err) {
    console.error("Annotation fetch failed:", err);
    res.status(500).json({ error: "Failed to read annotations" });
  }
});

app.post("/api/annotations/save", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { USER_DOCUMENTS } = userContext;
  
  const { name, overlays } = req.body || {};
  const info = resolvePdfName(name);
  if (!info) {
    return res.status(400).json({ error: "Invalid file name" });
  }
  
  // Check if user has access to this document
  if (!USER_DOCUMENTS.has(info.rel)) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (!Array.isArray(overlays) || overlays.length === 0) {
    return res.status(400).json({ error: "No overlays provided" });
  }

  let snapshot = null;
  let didUpdate = false;

  try {
    await withAnnotationLock(info.rel, async () => {
      await ensureAnnotationStore(info.rel);
      const index = await loadAnnotationIndex(info.rel);
      const pages = index.pages;

      // SECURITY FIX: Snapshot creation is MANDATORY for data integrity
      try {
        snapshot = await createAnnotationSnapshot(info, index);
        console.log('[ANNOTATION] Backup snapshot created:', snapshot.token);
      } catch (snapshotErr) {
        logError('[ANNOTATION] CRITICAL: Snapshot creation failed', snapshotErr, { rel: info.rel });
        throw new Error('Failed to create backup snapshot. Aborting save to prevent data loss.');
      }

      // SECURITY FIX: Validate ALL overlays before modifying (atomic transaction)
      try {
        for (const raw of overlays) {
          if (!raw || typeof raw !== "object") {
            throw new Error('Invalid overlay format');
          }
          const pageNumber = Number(raw.pageNumber);
          if (!Number.isInteger(pageNumber) || pageNumber < 1) {
            throw new Error(`Invalid page number: ${pageNumber}`);
          }
          
          // Validate data URL format and size
          const dataUrl = typeof raw.dataUrl === "string" ? raw.dataUrl.trim() : "";
          if (dataUrl) {
            if (!dataUrl.startsWith("data:image/png;base64,")) {
              throw new Error('Invalid data URL format (must be PNG base64)');
            }
            
            const base64 = dataUrl.slice("data:image/png;base64,".length);
            
            // Validate base64 format
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
              throw new Error('Invalid base64 encoding');
            }
            
            // Check decoded size (prevent memory exhaustion)
            const estimatedSize = (base64.length * 3) / 4;
            if (estimatedSize > 10 * 1024 * 1024) { // 10 MB limit per page
              throw new Error(`Annotation too large for page ${pageNumber} (max 10MB)`);
            }
          }
        }

        // All validations passed - now apply modifications atomically
        for (const raw of overlays) {
          const pageNumber = Number(raw.pageNumber);
          const dataUrl = typeof raw.dataUrl === "string" ? raw.dataUrl.trim() : "";
          const hasData = dataUrl.startsWith("data:image/png;base64,");
          
          const pageWidth = Number(raw.pageWidth);
          const pageHeight = Number(raw.pageHeight);
          const meta = {};
          if (Number.isFinite(pageWidth) && pageWidth > 0) meta.pageWidth = pageWidth;
          if (Number.isFinite(pageHeight) && pageHeight > 0) meta.pageHeight = pageHeight;

          const pagePath = getAnnotationPagePath(info.rel, pageNumber);

          if (hasData) {
            const base64 = dataUrl.slice("data:image/png;base64,".length);
            const buffer = Buffer.from(base64, "base64");
            
            if (buffer.length === 0) {
              throw new Error(`Empty buffer for page ${pageNumber}`);
            }
            
            await fs.promises.writeFile(pagePath, buffer);
            pages[pageNumber] = { ...pages[pageNumber], ...meta, updatedAt: Date.now() };
            didUpdate = true;
          } else {
            // Delete annotation
            try {
              await fs.promises.unlink(pagePath);
              if (pages[pageNumber]) {
                delete pages[pageNumber];
                didUpdate = true;
              }
            } catch (unlinkErr) {
              if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
            }
          }
        }

        if (!didUpdate) {
          console.log('[ANNOTATION] No changes detected, discarding snapshot');
          await discardAnnotationSnapshot(snapshot);
          return;
        }

        // Persist changes
        await saveAnnotationIndex(info.rel, index);
        await rebuildPdfFromAnnotations(info, index);
        
        // Finalize snapshot (marks as successful)
        await finalizeAnnotationSnapshot(snapshot);
        
        console.log('[ANNOTATION] Save completed successfully');

      } catch (modifyErr) {
        // SECURITY FIX: Rollback on any error
        console.error('[ANNOTATION] Modification failed, discarding snapshot:', modifyErr.message);
        await discardAnnotationSnapshot(snapshot);
        throw modifyErr;
      }
    });

    const st = await statSafe(info.abs);
    if (st) {
      const idx = indexCache.items.findIndex((item) => item && item.name === info.rel);
      if (idx !== -1) {
        indexCache.items[idx] = { ...indexCache.items[idx], size: st.size, mtime: st.mtimeMs };
      }
    }

    try {
      await ensureThumbnail({ rel: info.rel, abs: info.abs });
    } catch (thumbErr) {
      console.warn("Annotation thumbnail refresh failed:", thumbErr?.message || thumbErr);
    }

    res.json({ 
      ok: true, 
      mtime: st ? st.mtimeMs : null, 
      size: st ? st.size : null,
      modified: didUpdate
    });
  } catch (err) {
    logError("Annotation save failed", err, { 
      rel: info?.rel, 
      userId: req.auth?.user?.id,
      overlayCount: Array.isArray(req.body?.overlays) ? req.body.overlays.length : 0
    });
    
    // SECURITY FIX: Cleanup orphaned snapshots on error
    if (snapshot && snapshot.dir) {
      try {
        await discardAnnotationSnapshot(snapshot);
        console.log('[ANNOTATION] Cleaned up orphaned snapshot after error');
      } catch (cleanupErr) {
        console.error('[ANNOTATION] Failed to cleanup orphaned snapshot:', cleanupErr.message);
      }
    }
    
    // Send sanitized error (no internal details to client)
    const userMessage = err.message && err.message.includes('backup snapshot')
      ? 'Failed to create backup. Please try again.'
      : err.message && err.message.includes('Invalid')
      ? err.message
      : 'Failed to apply annotations';
    
    return sendError(res, 500, userMessage, err, 'Annotation save');
  }
});

app.post("/api/annotations/undo", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { USER_DOCUMENTS } = userContext;
  
  const { name } = req.body || {};
  const info = resolvePdfName(name);
  if (!info) {
    return res.status(400).json({ error: "Invalid file name" });
  }
  
  // Check if user has access to this document
  if (!USER_DOCUMENTS.has(info.rel)) {
    return res.status(403).json({ error: "Access denied" });
  }

  let result = null;
  try {
    await withAnnotationLock(info.rel, async () => {
      await ensureAnnotationStore(info.rel);
      const snapshot = await getLatestAnnotationSnapshot(info.rel);
      if (!snapshot) {
        result = null;
        return;
      }

      const snapshotIndex = await loadSnapshotIndex(snapshot);
      const restorePages = snapshotIndex && typeof snapshotIndex === "object" && snapshotIndex.pages && typeof snapshotIndex.pages === "object"
        ? snapshotIndex.pages
        : {};
      const restoreKeys = Object.keys(restorePages || {}).map((key) => String(key));
      const restoreSet = new Set(restoreKeys);

      const currentIndex = await loadAnnotationIndex(info.rel);
      const currentKeys = Object.keys(currentIndex.pages || {}).map((key) => String(key));

      for (const key of currentKeys) {
        if (!restoreSet.has(key)) {
          await fs.promises.unlink(getAnnotationPagePath(info.rel, key)).catch(() => {});
        }
      }

      for (const key of restoreKeys) {
        const src = path.join(snapshot.dir, `page-${key}.png`);
        const dest = getAnnotationPagePath(info.rel, key);
        try {
          await fs.promises.copyFile(src, dest);
        } catch (err) {
          if (!err || err.code !== "ENOENT") {
            console.warn("Failed to restore annotation page", info.rel, key, err?.message || err);
          } else {
            await fs.promises.unlink(dest).catch(() => {});
          }
        }
      }

      const restoreIndex = { rel: info.rel, pages: restorePages };
      await saveAnnotationIndex(info.rel, restoreIndex);
      await rebuildPdfFromAnnotations(info, restoreIndex);
      const pages = await serializeAnnotationPages(info, restoreIndex);
      await fs.promises.rm(snapshot.dir, { recursive: true, force: true }).catch(() => {});
      const remainingHistory = await listAnnotationSnapshots(info.rel);
      result = {
        pages,
        timestamp: snapshot.timestamp || null,
        historyRemaining: remainingHistory.length,
      };
    });
  } catch (err) {
    console.error("Annotation undo failed:", err);
    return res.status(500).json({ error: "Failed to restore annotations" });
  }

  if (!result) {
    return res.status(409).json({ error: "Keine vorherige Version vorhanden" });
  }

  const st = await statSafe(info.abs);
  if (st) {
    const idx = indexCache.items.findIndex((item) => item && item.name === info.rel);
    if (idx !== -1) {
      indexCache.items[idx] = { ...indexCache.items[idx], size: st.size, mtime: st.mtimeMs };
    }
  }

  try {
    await ensureThumbnail({ rel: info.rel, abs: info.abs });
  } catch (thumbErr) {
    console.warn("Annotation thumbnail refresh failed:", thumbErr?.message || thumbErr);
  }

  res.json({
    ok: true,
    restoredAt: result.timestamp,
    historyRemaining: result.historyRemaining,
    pages: result.pages,
    mtime: st ? st.mtimeMs : null,
    size: st ? st.size : null,
  });
});

app.post("/api/annotations/reset", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { USER_DOCUMENTS } = userContext;
  
  const { name } = req.body || {};
  const info = resolvePdfName(name);
  if (!info) {
    return res.status(400).json({ error: "Invalid file name" });
  }
  
  // Check if user has access to this document
  if (!USER_DOCUMENTS.has(info.rel)) {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    await withAnnotationLock(info.rel, async () => {
      await ensureAnnotationStore(info.rel);
      const currentIndex = await loadAnnotationIndex(info.rel);
      const hasAnyPage = Object.keys(currentIndex.pages || {}).length > 0;
      let snapshot = null;

      if (hasAnyPage) {
        try {
          snapshot = await createAnnotationSnapshot(info, currentIndex);
        } catch (snapshotErr) {
          console.warn(
            "Failed to capture annotation snapshot before reset",
            info.rel,
            snapshotErr?.message || snapshotErr
          );
        }
      }

      try {
        await resetAnnotationStore(info);
        await saveAnnotationIndex(info.rel, { rel: info.rel, pages: {} });
        if (snapshot) {
          await finalizeAnnotationSnapshot(snapshot);
        }
      } catch (err) {
        await discardAnnotationSnapshot(snapshot);
        throw err;
      }
    });

    const st = await statSafe(info.abs);
    if (st) {
      const idx = indexCache.items.findIndex((item) => item && item.name === info.rel);
      if (idx !== -1) {
        indexCache.items[idx] = { ...indexCache.items[idx], size: st.size, mtime: st.mtimeMs };
      }
    }

    try {
      await ensureThumbnail({ rel: info.rel, abs: info.abs });
    } catch (thumbErr) {
      console.warn("Annotation thumbnail refresh failed:", thumbErr?.message || thumbErr);
    }

    res.json({ ok: true, mtime: st ? st.mtimeMs : null, size: st ? st.size : null });
  } catch (err) {
    console.error("Annotation reset failed:", err);
    res.status(500).json({ error: "Failed to reset annotations" });
  }
});

app.get("/api/categories", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { CONFIG } = userContext;
  res.setHeader("Cache-Control", "no-store");
  res.json({ categories: CONFIG.categories.map((cat) => ({ ...cat })) });
});

app.post("/api/categories", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { CONFIG } = userContext;
  
  const { name, color, icon } = req.body || {};
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName) {
    return res.status(400).json({ error: "Name required" });
  }

  const existingIds = new Set(CONFIG.categories.map((cat) => cat.id));
  const baseId = slugifyCategoryId(trimmedName);
  const id = ensureUniqueCategoryId(baseId, existingIds);
  const category = {
    id,
    name: trimmedName,
    color: sanitizeHexColor(color || DEFAULT_CATEGORY_COLOR),
    icon: sanitizeCategoryIcon(icon),
  };

  CONFIG.categories.push(category);
  CONFIG.categories.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  
  try {
    await userContext.persistConfigNow();
  } catch (err) {
    // Rollback: remove the category we just added
    const idx = CONFIG.categories.findIndex((cat) => cat.id === id);
    if (idx !== -1) CONFIG.categories.splice(idx, 1);
    console.error("Failed to persist new category:", err);
    return res.status(500).json({ error: "Failed to persist category" });
  }

  res.status(201).json({ category: { ...category }, categories: CONFIG.categories.map((cat) => ({ ...cat })) });
});

app.put("/api/categories/:id", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { CONFIG } = userContext;
  
  const id = (req.params.id || "").toString();

  const target = getCategoryById(id);
  if (!target) return res.status(404).json({ error: "Category not found" });

  // Save original state for rollback
  const originalName = target.name;
  const originalColor = target.color;
  const originalIcon = target.icon;

  const { name, color, icon } = req.body || {};
  if (name !== undefined) {
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (!trimmedName) {
      return res.status(400).json({ error: "Name required" });
    }
    target.name = trimmedName;
  }
  if (color !== undefined) {
    target.color = sanitizeHexColor(color);
  }
  if (icon !== undefined) {
    target.icon = sanitizeCategoryIcon(icon);
  }

  CONFIG.categories.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  
  try {
    await userContext.persistConfigNow();
  } catch (err) {
    // Rollback changes
    target.name = originalName;
    target.color = originalColor;
    target.icon = originalIcon;
    CONFIG.categories.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    console.error("Failed to persist category update:", err);
    return res.status(500).json({ error: "Failed to persist category" });
  }
  
  refreshIndexCategoryMetadata(id);

  res.json({ category: { ...target }, categories: CONFIG.categories.map((cat) => ({ ...cat })) });
});

app.delete("/api/categories/:id", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const { CONFIG } = userContext;
  
  const id = (req.params.id || "").toString();
  const idx = CONFIG.categories.findIndex((cat) => cat.id === id);
  if (idx === -1) return res.status(404).json({ error: "Category not found" });

  // Save for rollback
  const removedCategory = CONFIG.categories[idx];
  const affectedFiles = {};
  
  // Track affected files for rollback
  for (const [rel, cfg] of Object.entries(CONFIG.files)) {
    if (cfg && Array.isArray(cfg.categories) && cfg.categories.includes(id)) {
      affectedFiles[rel] = [...cfg.categories];
    }
  }

  CONFIG.categories.splice(idx, 1);
  removeCategoryFromFiles(id);
  
  try {
    await userContext.persistConfigNow();
  } catch (err) {
    // Rollback: restore category and file associations
    CONFIG.categories.splice(idx, 0, removedCategory);
    for (const [rel, originalCategories] of Object.entries(affectedFiles)) {
      if (CONFIG.files[rel]) {
        CONFIG.files[rel].categories = originalCategories;
      }
    }
    console.error("Failed to persist category removal:", err);
    return res.status(500).json({ error: "Failed to persist category removal" });
  }
  
  refreshIndexCategoryMetadata(id);

  res.json({ ok: true, categories: CONFIG.categories.map((cat) => ({ ...cat })) });
});

/* ---------------- Delete PDF ---------------- */
app.delete("/api/sheets/:name", async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  
  const { name } = req.params;
  const info = resolvePdfName(name);
  
  if (!info) {
    return res.status(404).json({ error: "PDF nicht gefunden" });
  }
  
  const userId = req.auth.user.id;
  const userRole = req.auth.user.role;
  
  // Check ownership: only owner or admin can delete
  const ownedDocs = dataStore.listOwnedDocumentRelPaths(userId);
  const isOwner = ownedDocs.includes(info.rel);
  const isAdmin = userRole === "admin";
  
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ 
      error: "Keine Berechtigung", 
      details: "Nur der Besitzer oder ein Administrator kann dieses PDF löschen."
    });
  }
  
  try {
    // 1. Delete physical PDF file
    await fs.promises.unlink(info.abs).catch((err) => {
      if (err?.code !== "ENOENT") throw err;
    });
    
    // 2. Delete thumbnail
    const thumbPath = path.join(THUMBS_DIR, thumbnailRelPath(info.rel));
    await fs.promises.unlink(thumbPath).catch((err) => {
      if (err?.code !== "ENOENT") {
        logError("Failed to delete thumbnail", err, { rel: info.rel });
      }
    });
    
    // 3. Delete annotation directory (includes all versions and base PDF)
    const annotationDir = getAnnotationDir(info.rel);
    await fs.promises.rm(annotationDir, { recursive: true, force: true }).catch((err) => {
      logError("Failed to delete annotations", err, { rel: info.rel });
    });
    
    // 4. Remove from ALL users' configs (favorites, file configs)
    // Admin deletion affects all users
    if (isAdmin) {
      const allUsers = authService.listUsers();
      for (const user of allUsers) {
        try {
          const userConfigEntry = await dataStore.getUserConfig(user.id);
          let configChanged = false;
          
          // Remove from favorites
          if (Array.isArray(userConfigEntry.favorites)) {
            const originalLength = userConfigEntry.favorites.length;
            userConfigEntry.favorites = userConfigEntry.favorites.filter(fav => fav !== info.rel);
            if (userConfigEntry.favorites.length !== originalLength) {
              configChanged = true;
            }
          }
          
          // Remove from file config
          if (userConfigEntry.files && userConfigEntry.files[info.rel]) {
            delete userConfigEntry.files[info.rel];
            configChanged = true;
          }
          
          if (configChanged) {
            await dataStore.saveUserConfig(user.id, userConfigEntry);
          }
        } catch (err) {
          logError("Failed to clean user config after delete", err, { userId: user.id, rel: info.rel });
        }
      }
    } else {
      // Owner deletion: only affect their own config
      const { CONFIG } = userContext;
      
      // Remove from favorites
      const favSet = new Set(CONFIG.favorites);
      if (favSet.has(info.rel)) {
        favSet.delete(info.rel);
        CONFIG.favorites = Array.from(favSet).sort((a, b) => 
          a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
        );
        userContext.markConfigDirty();
      }
      
      // Remove from file config
      if (CONFIG.files[info.rel]) {
        delete CONFIG.files[info.rel];
        userContext.markConfigDirty();
      }
      
      await userContext.saveConfigImmediate().catch((err) => {
        logError("Failed to save config after delete", err);
      });
    }
    
    // 5. Remove from ALL users' playlists
    if (isAdmin) {
      const allUsers = authService.listUsers();
      for (const user of allUsers) {
        try {
          const userPlaylistsEntry = await dataStore.getUserPlaylists(user.id);
          let playlistsChanged = false;
          
          if (Array.isArray(userPlaylistsEntry.playlists)) {
            userPlaylistsEntry.playlists.forEach((playlist) => {
              if (Array.isArray(playlist.items)) {
                const originalLength = playlist.items.length;
                playlist.items = playlist.items.filter(item => item !== info.rel);
                
                if (playlist.items.length !== originalLength) {
                  playlistsChanged = true;
                  // Adjust currentIndex if needed
                  if (playlist.currentIndex >= playlist.items.length) {
                    playlist.currentIndex = playlist.items.length ? playlist.items.length - 1 : -1;
                  }
                  playlist.updatedAt = Date.now();
                }
              }
            });
          }
          
          if (playlistsChanged) {
            userPlaylistsEntry.updatedAt = Date.now();
            await dataStore.saveUserPlaylists(user.id, userPlaylistsEntry);
          }
        } catch (err) {
          logError("Failed to clean user playlists after delete", err, { userId: user.id, rel: info.rel });
        }
      }
    } else {
      // Owner deletion: only affect their own playlists
      const { PLAYLIST_STATE } = userContext;
      let playlistsChanged = false;
      
      PLAYLIST_STATE.playlists.forEach((playlist) => {
        const originalLength = playlist.items.length;
        playlist.items = playlist.items.filter(item => item !== info.rel);
        
        if (playlist.items.length !== originalLength) {
          playlistsChanged = true;
          // Adjust currentIndex if needed
          if (playlist.currentIndex >= playlist.items.length) {
            playlist.currentIndex = playlist.items.length ? playlist.items.length - 1 : -1;
          }
          updatePlaylistTimestamp(playlist);
        }
      });
      
      if (playlistsChanged) {
        await savePlaylistsImmediate().catch((err) => {
          logError("Failed to save playlists after delete", err);
        });
        broadcastPlaylists(req.auth?.user?.id);
      }
    }
    
    // 6. Remove from index cache
    indexCache.items = indexCache.items.filter(item => item && item.name !== info.rel);
    indexCache.at = Date.now();
    
    // 7. Remove from database (user_documents table)
    // This is handled by removing the document entry itself if no other users reference it
    try {
      // For admin: remove document entirely from all users
      // For owner: only remove their association (but keep if others have access)
      if (isAdmin) {
        // Admin can delete the document entirely - remove all user associations
        const db = authService.query;
        const docRow = db.get(`SELECT id FROM documents WHERE rel_path = ?`, [info.rel]);
        if (docRow) {
          // Remove all user_documents entries
          authService.transactional(({ run }) => {
            run(`DELETE FROM user_documents WHERE document_id = ?`, [docRow.id]);
            run(`DELETE FROM documents WHERE id = ?`, [docRow.id]);
          });
        }
      } else {
        // Owner: only remove their own association
        const db = authService.query;
        const docRow = db.get(`SELECT id FROM documents WHERE rel_path = ?`, [info.rel]);
        if (docRow) {
          authService.transactional(({ run }) => {
            run(`DELETE FROM user_documents WHERE user_id = ? AND document_id = ?`, [userId, docRow.id]);
            
            // Check if any other users still reference this document
            const remainingRefs = db.get(
              `SELECT COUNT(*) as count FROM user_documents WHERE document_id = ?`,
              [docRow.id]
            );
            
            // If no other references, delete the document itself
            if (remainingRefs && remainingRefs.count === 0) {
              run(`DELETE FROM documents WHERE id = ?`, [docRow.id]);
            }
          });
        }
      }
      
      // Update user document cache
      const userDocSet = userDocumentCache.get(userId);
      if (userDocSet) {
        userDocSet.delete(info.rel);
      }
    } catch (err) {
      logError("Failed to remove document from database", err, { rel: info.rel });
      // Continue - file is already deleted
    }
    
    console.log(`PDF deleted successfully: ${info.rel} by user ${userId} (${isAdmin ? 'admin' : 'owner'})`);
    
    res.json({ 
      ok: true, 
      message: "PDF erfolgreich gelöscht",
      deletedFile: info.rel
    });
    
  } catch (err) {
    logError("PDF deletion failed", err, { rel: info.rel, userId });
    return sendError(res, 500, "Fehler beim Löschen des PDFs", err, "Delete PDF");
  }
});

/* ---------------- Health endpoint ---------------- */
app.get("/healthz", async (req, res) => {
  try {
    const okSheets = fs.existsSync(SHEETS_DIR);
    const count = (await getIndex()).length;
    const mem = process.memoryUsage();
    
    res.json({ 
      ok: true, 
      sheetsDir: okSheets, 
      files: count,
      memory: {
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        uptime: Math.round(process.uptime())
      },
      cache: {
        size: indexCache.items.length,
        lastScan: indexCache.at ? new Date(indexCache.at).toISOString() : null
      }
    });
  } catch {
    res.status(500).json({ ok: false });
  }
});

/* ---------------- SPA Fallback - MUST be last route ---------------- */
app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});
} // End of registerApiRoutes()

/* ---------------- Index & Scanning (Memory-optimized) ---------------- */
async function scanDir() {
  // Prevent concurrent scans
  if (indexCache.scanInProgress) {
    return indexCache.items;
  }
  
  indexCache.scanInProgress = true;
  
  try {
    const discovered = [];
    const stack = [""];

    while (stack.length) {
      const relDir = stack.pop();
      const absDir = path.join(SHEETS_DIR, relDir);

      let dirHandle;
      try {
        dirHandle = await fs.promises.opendir(absDir);
      } catch (err) {
        console.warn(`scanDir: unable to open ${absDir}:`, err.message);
        continue;
      }

      for await (const entry of dirHandle) {
        if (!entry || entry.name === "." || entry.name === "..") continue;
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

        if (entry.name.startsWith(".")) continue;

        if (entry.isDirectory()) {
          stack.push(relPath);
          continue;
        }

        if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
          discovered.push(toPosixPath(relPath));
        }
      }
    }

    const results = [];
    const concurrency = Math.min(
      MEMORY_SETTINGS.maxStatConcurrency,
      Math.max(2, CPU_COUNT * 2)
    );
    let cursor = 0;

    const workerCount = Math.min(concurrency, Math.max(1, discovered.length));
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push((async () => {
      while (true) {
        const currentIndex = cursor++;
        if (currentIndex >= discovered.length) break;
        const rel = discovered[currentIndex];
        const abs = path.join(SHEETS_DIR, rel);
        const st = await statSafe(abs);
        if (!st) continue;

        const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        const displayName = path.basename(rel);
        const encodedRel = encodePathSegments(rel);
        const encodedThumb = encodePathSegments(thumbnailRelPath(rel));
        
        // Note: Category info is user-specific and will be added dynamically in /api/sheets
        // We don't store it in the global cache
        results.push({
          id: encodeURIComponent(rel),
          name: rel,
          displayName,
          folder,
          url: `/sheets/${encodedRel}`,
          thumbnail: `/thumbnails/${encodedThumb}`,
          size: st.size,
          mtime: st.mtimeMs,
          categoryIds: [],
          categories: [],
        });
      }
      })());
    }

    await Promise.all(workers);

    const items = results.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    indexCache = { at: Date.now(), items, scanInProgress: false };

    // console.log(`Scanned ${items.length} PDF files (recursive)`);
    return items;
  } catch (e) {
    console.error("scanDir failed:", e);
    return indexCache.items; // Return cached items on error
  } finally {
    indexCache.scanInProgress = false;
  }
}

async function getIndex() {
  if (Date.now() - indexCache.at > MEMORY_SETTINGS.maxIndexCacheAge || !indexCache.items.length) {
    try { 
      await scanDir(); 
    } catch (e) { 
      console.error("getIndex -> scanDir failed:", e); 
    }
  }
  return indexCache.items;
}

function applySort(items, sort, order) {
  const o = (order || "asc").toLowerCase() === "desc" ? -1 : 1;
  switch ((sort || "name").toLowerCase()) {
    case "mtime": return items.slice().sort((a, b) => (a.mtime - b.mtime) * o);
    case "size":  return items.slice().sort((a, b) => (a.size - b.size) * o);
    default:      return items.slice().sort((a, b) =>
      (a.displayName || a.name || "").localeCompare(b.displayName || b.name || "", undefined, { numeric: true, sensitivity: "base" }) * o
    );
  }
}

/* ---------------- Sheet Watcher (File System Monitor) ---------------- */
function initSheetWatcher() {
  if (typeof fs.watch !== "function") return null;
  try {
    let invalidateTimer = null;
    const watcher = fs.watch(SHEETS_DIR, { recursive: true }, () => {
      clearTimeout(invalidateTimer);
      invalidateTimer = setTimeout(() => {
        indexCache.at = 0;
      }, 100);
    });
    watcher.on("error", (err) => {
      console.warn("Sheet watcher error:", err.message);
    });
    console.log("Sheet watcher active (recursive)");
    return watcher;
  } catch (err) {
    console.warn("Sheet watcher not available:", err.message);
    return null;
  }
}

/* ---------------- Database Cleanup Helper ---------------- */
/**
 * Cleans up orphaned document entries from the database.
 * Removes documents that no longer have corresponding PDF files in the sheets directory.
 * This handles cases where files were deleted manually without using the API.
 */
async function cleanupOrphanedDocuments() {
  if (!authService || !dataStore) {
    console.warn("Cannot cleanup orphaned documents: services not initialized");
    return;
  }

  try {
    console.log("🔍 Starting database cleanup check...");
    
    // Get all documents from database
    const allDocumentsInDb = authService.query.all(
      `SELECT id, rel_path FROM documents`
    );
    
    if (!allDocumentsInDb || allDocumentsInDb.length === 0) {
      console.log("✅ Database cleanup: No documents in database");
      return;
    }
    
    console.log(`📊 Found ${allDocumentsInDb.length} documents in database`);
    
    // Check which ones still exist in filesystem
    const orphanedDocs = [];
    
    for (const doc of allDocumentsInDb) {
      const absPath = path.join(SHEETS_DIR, doc.rel_path);
      
      try {
        await fs.promises.access(absPath, fs.constants.F_OK);
        // File exists - all good
      } catch (err) {
        // File does not exist - this is an orphaned entry
        orphanedDocs.push(doc);
      }
    }
    
    if (orphanedDocs.length === 0) {
      console.log("✅ Database cleanup: All document entries are valid");
      return;
    }
    
    console.log(`🗑️  Found ${orphanedDocs.length} orphaned document(s) to clean up:`);
    orphanedDocs.forEach(doc => {
      console.log(`   - ${doc.rel_path} (ID: ${doc.id})`);
    });
    
    // Clean up orphaned entries
    let cleanedCount = 0;
    
    for (const doc of orphanedDocs) {
      try {
        // Remove from database using transactional
        authService.transactional(({ run }) => {
          // Remove user_documents associations
          run(`DELETE FROM user_documents WHERE document_id = ?`, [doc.id]);
          // Remove document itself
          run(`DELETE FROM documents WHERE id = ?`, [doc.id]);
        });
        
        cleanedCount++;
        console.log(`   ✓ Cleaned up: ${doc.rel_path}`);
        
        // Also clean up related files (thumbnails, annotations)
        try {
          // Remove thumbnail
          const thumbPath = path.join(THUMBS_DIR, thumbnailRelPath(doc.rel_path));
          await fs.promises.unlink(thumbPath).catch(() => {});
          
          // Remove annotation directory
          const annotationDir = getAnnotationDir(doc.rel_path);
          await fs.promises.rm(annotationDir, { recursive: true, force: true }).catch(() => {});
        } catch (cleanupErr) {
          // Non-critical - just log
          console.log(`   ⚠️  Could not clean up related files for ${doc.rel_path}`);
        }
        
      } catch (err) {
        logError("Failed to cleanup orphaned document", err, { docId: doc.id, relPath: doc.rel_path });
      }
    }
    
    console.log(`✅ Database cleanup complete: Removed ${cleanedCount} orphaned document(s)`);
    
    // Also clean up user configs - remove references to deleted files
    await cleanupUserConfigs(orphanedDocs.map(d => d.rel_path));
    
  } catch (err) {
    logError("Database cleanup failed", err);
    console.warn("⚠️  Database cleanup encountered errors - continuing startup");
  }
}

/**
 * Removes references to deleted files from all user configs
 */
async function cleanupUserConfigs(deletedRelPaths) {
  if (!deletedRelPaths || deletedRelPaths.length === 0) return;
  
  try {
    const deletedSet = new Set(deletedRelPaths);
    const allUsers = authService.listUsers();
    let cleanedUsers = 0;
    
    for (const user of allUsers) {
      try {
        const userConfig = await dataStore.getUserConfig(user.id);
        let configChanged = false;
        
        // Remove from favorites
        if (Array.isArray(userConfig.favorites)) {
          const originalLength = userConfig.favorites.length;
          userConfig.favorites = userConfig.favorites.filter(fav => !deletedSet.has(fav));
          if (userConfig.favorites.length !== originalLength) {
            configChanged = true;
          }
        }
        
        // Remove from file configs
        if (userConfig.files && typeof userConfig.files === 'object') {
          for (const relPath of deletedRelPaths) {
            if (userConfig.files[relPath]) {
              delete userConfig.files[relPath];
              configChanged = true;
            }
          }
        }
        
        if (configChanged) {
          await dataStore.saveUserConfig(user.id, userConfig);
          cleanedUsers++;
        }
        
        // Clean up playlists
        const userPlaylists = await dataStore.getUserPlaylists(user.id);
        let playlistsChanged = false;
        
        if (Array.isArray(userPlaylists.playlists)) {
          userPlaylists.playlists.forEach((playlist) => {
            if (Array.isArray(playlist.items)) {
              const originalLength = playlist.items.length;
              playlist.items = playlist.items.filter(item => !deletedSet.has(item));
              
              if (playlist.items.length !== originalLength) {
                playlistsChanged = true;
                // Adjust currentIndex if needed
                if (playlist.currentIndex >= playlist.items.length) {
                  playlist.currentIndex = playlist.items.length ? playlist.items.length - 1 : -1;
                }
                playlist.updatedAt = Date.now();
              }
            }
          });
        }
        
        if (playlistsChanged) {
          userPlaylists.updatedAt = Date.now();
          await dataStore.saveUserPlaylists(user.id, userPlaylists);
        }
        
      } catch (err) {
        logError("Failed to cleanup user config", err, { userId: user.id });
      }
    }
    
    if (cleanedUsers > 0) {
      console.log(`   ✓ Cleaned ${cleanedUsers} user config(s)`);
    }
    
  } catch (err) {
    logError("Failed to cleanup user configs", err);
  }
}

/* ---------------- Server Initialization ---------------- */
let server = null;
let authService = null;
let dataStore = null;
let userContext = null;
let sseManager = null;
let sheetWatcher = null;

// =============================================================================
// SECURITY: User-based Rate Limiting System (Global Scope)
// =============================================================================
const loginAttempts = new Map(); // email -> { count, firstAttempt, lockUntil }

function checkRateLimit(email) {
  const now = Date.now();
  const record = loginAttempts.get(email);
  
  if (!record) return { allowed: true };
  
  // Check if locked
  if (record.lockUntil && now < record.lockUntil) {
    const remainingMinutes = Math.ceil((record.lockUntil - now) / 60000);
    return { 
      allowed: false, 
      reason: `Account temporarily locked. Try again in ${remainingMinutes} minute(s).`,
      lockUntil: record.lockUntil
    };
  }
  
  // Reset if window expired (15 minutes)
  if (now - record.firstAttempt > 15 * 60 * 1000) {
    loginAttempts.delete(email);
    return { allowed: true };
  }
  
  return { allowed: true };
}

function recordFailedLogin(email) {
  const now = Date.now();
  const record = loginAttempts.get(email) || { count: 0, firstAttempt: now };
  
  record.count++;
  record.lastAttempt = now;
  
  // Progressive lockout
  if (record.count >= 20) {
    record.lockUntil = now + 24 * 60 * 60 * 1000; // 24 hours (permanent)
    console.warn('[SECURITY] Account locked (20+ failed attempts):', { email });
  } else if (record.count >= 10) {
    record.lockUntil = now + 60 * 60 * 1000; // 1 hour
    console.warn('[SECURITY] Account locked (10+ failed attempts):', { email });
  } else if (record.count >= 5) {
    record.lockUntil = now + 15 * 60 * 1000; // 15 minutes
    console.warn('[SECURITY] Account locked (5+ failed attempts):', { email });
  }
  
  loginAttempts.set(email, record);
}

function recordSuccessfulLogin(email) {
  loginAttempts.delete(email);
}

// =============================================================================
// SECURITY: CSRF Protection System (Global Scope)
// =============================================================================
const csrfTokens = new Map(); // sessionId -> { token, createdAt }

function generateCsrfToken(sessionId, force = false) {
  // Check if token already exists (don't regenerate unless forced)
  const existing = csrfTokens.get(sessionId);
  if (existing && !force) {
    console.log('[CSRF] Reusing existing token for session:', sessionId);
    return existing.token;
  }
  
  const token = randomUUID();
  csrfTokens.set(sessionId, { token, createdAt: Date.now() });
  console.log('[CSRF] Generated new token for session:', sessionId, token.substring(0, 8) + '...');
  return token;
}

function validateCsrfToken(sessionId, token) {
  const record = csrfTokens.get(sessionId);
  if (!record) return false;
  
  // Tokens expire after 24 hours
  if (Date.now() - record.createdAt > 24 * 60 * 60 * 1000) {
    csrfTokens.delete(sessionId);
    return false;
  }
  
  return record.token === token;
}

function csrfProtection(req, res, next) {
  // Skip CSRF for GET, HEAD, OPTIONS
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }
  
  // Skip CSRF for login endpoint (no session yet)
  if (req.path === '/auth/login') {
    return next();
  }
  
  // Skip CSRF for anonymous page view tracking
  if (req.path === '/stats/pageview') {
    return next();
  }
  
  // Skip CSRF for batch share info endpoint (makes many requests)
  if (req.path === '/share/info/batch') {
    return next();
  }
  
  // Skip CSRF for playlist current index updates (frequent navigation)
  if (req.path.match(/^\/playlists\/[^\/]+\/items\/current$/)) {
    return next();
  }
  
  // Skip CSRF for playlist activation (frequent switching between playlists)
  if (req.path.match(/^\/playlists\/[^\/]+\/activate$/)) {
    return next();
  }
  
  const sessionId = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!sessionId) {
    return res.status(403).json({ error: 'No session' });
  }
  
  const csrfToken = req.headers['x-csrf-token'] || req.body?._csrf;
  if (!csrfToken) {
    console.warn('[SECURITY] CSRF token missing:', { 
      method: req.method, 
      path: req.path, 
      sessionId,
      headers: Object.keys(req.headers).filter(h => h.toLowerCase().includes('csrf') || h.toLowerCase().includes('x-'))
    });
    return res.status(403).json({ error: 'CSRF token missing' });
  }
  
  const isValid = validateCsrfToken(sessionId, csrfToken);
  if (!isValid) {
    console.warn('[SECURITY] Invalid CSRF token:', { 
      method: req.method, 
      path: req.path, 
      sessionId,
      receivedToken: csrfToken ? csrfToken.substring(0, 8) + '...' : 'null',
      expectedToken: csrfTokens.get(sessionId) ? csrfTokens.get(sessionId).token.substring(0, 8) + '...' : 'none'
    });
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  
  // Send fresh CSRF token in response header for client to update
  const freshToken = csrfTokens.get(sessionId)?.token;
  if (freshToken) {
    res.setHeader('X-CSRF-Token', freshToken);
  }
  
  next();
}
(async () => {
  try { 
    await ensureVendors(); 
  } catch { 
    console.warn("Vendor prefetch failed – will lazy-fetch on demand"); 
  }
  try {
    authService = await createAuthService({ dataDir: DATA_DIR, logger: console });
    dataStore = await createDataStore({ authService, dataDir: DATA_DIR, sheetsDir: SHEETS_DIR, logger: console });
    await dataStore.ensureInitialMigration();
    
    // Initialize user context middleware and SSE manager
    const { createUserContextMiddleware } = require("./lib/user-context-middleware");
    const { UserSSEManager } = require("./lib/user-sse-manager");
    
    userContext = createUserContextMiddleware({ dataStore, logger: console });
    sseManager = new UserSSEManager({ logger: console });
    
    // Start cleanup intervals for rate limiting and CSRF tokens
    setInterval(() => {
      const now = Date.now();
      const CLEANUP_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours
      
      // Cleanup rate limiting records
      for (const [email, record] of loginAttempts.entries()) {
        if (now - record.lastAttempt > CLEANUP_THRESHOLD) {
          loginAttempts.delete(email);
        }
      }
      
      // Cleanup expired CSRF tokens
      for (const [sessionId, record] of csrfTokens.entries()) {
        if (now - record.createdAt > CLEANUP_THRESHOLD) {
          csrfTokens.delete(sessionId);
        }
      }
    }, 60 * 60 * 1000);
    
    // Register middleware and all API routes after userContext is initialized
    // NOTE: registerApiRoutes() adds session middleware BEFORE user context middleware
    registerApiRoutes();
    
    console.log("User context middleware, SSE manager, CSRF protection, and API routes initialized");
  } catch (err) {
    console.error("Failed to initialize authentication/data store:", err);
    process.exit(1);
  }
  // Database cleanup: Remove orphaned document entries
  await cleanupOrphanedDocuments();
  
  sheetWatcher = initSheetWatcher();
  
  server = app.listen(PORT, () => {
    console.log(`Piano Sheets running: http://localhost:${PORT}`);
    console.log(`PDFs: ${SHEETS_DIR}`);
    console.log(`Memory monitoring enabled. Start with --expose-gc for manual GC.`);
    
    // Initial scan
    getIndex().then(items => {
      console.log(`Initial scan complete: ${items.length} PDF files found`);
    }).catch(e => {
      console.warn("Initial scan failed:", e.message);
    });
  });
  
  // Periodic memory monitoring
  setInterval(() => {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    if (heapMB > 256) { // Log when > 256MB
      console.log(`Memory usage: ${heapMB}MB heap, ${indexCache.items.length} cached files`);
      if (heapMB > 512 && typeof global.gc === "function") {
        try { global.gc(); } catch {}
      }
    }
  }, 60000); // Every minute
})();

// Graceful shutdown for live use
let shuttingDown = false;

async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${sig} received – shutting down…`);

  if (sheetWatcher && typeof sheetWatcher.close === "function") {
    try { sheetWatcher.close(); } catch (err) {
      console.warn("Error closing sheet watcher:", err.message);
    }
  }

  await flushConfigBeforeExit();

  if (!server) {
    process.exit(0);
    return;
  }

  server.close((err) => {
    if (err) {
      console.error("Error closing server:", err.message);
      process.exit(1);
    } else {
      process.exit(0);
    }
  });

  // hard exit after 5s
  setTimeout(() => {
    console.warn("Forced shutdown after timeout");
    process.exit(1);
  }, 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("beforeExit", () => {
  flushConfigBeforeExit().catch((err) => {
    console.error("beforeExit flush failed:", err);
  });
});
process.on("uncaughtException", (e) => { console.error("uncaughtException", e); });
process.on("unhandledRejection", (e) => { console.error("unhandledRejection", e); });
