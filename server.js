// server.js — Piano Sheets (server-side thumbnail generation for performance)

const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const { randomUUID } = require("crypto");
const { PDFDocument } = require("pdf-lib");

// Optional middlewares (used if installed; otherwise skipped)
let helmet = null, morgan = null, compression = null;
try { helmet = require("helmet"); } catch {}
try { morgan = require("morgan"); } catch {}
try { compression = require("compression"); } catch {}

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
  return CONFIG.categories.find((cat) => cat.id === id);
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
}

function refreshIndexCategoryMetadata(catId) {
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
}

function removeCategoryFromFiles(catId) {
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
    console.log('resolvePdfName: name is not a string:', typeof name);
    return null;
  }

  let candidate = name.trim();
  if (!candidate) {
    console.log('resolvePdfName: name is empty after trim');
    return null;
  }
  
  const original = candidate;
  try { candidate = decodeURIComponent(candidate); } catch (err) {
    console.log('resolvePdfName: decodeURIComponent failed for:', original, err.message);
  }

  const normalized = path.posix.normalize(toPosixPath(candidate));
  
  console.log('resolvePdfName debug:', {
    input: name,
    trimmed: original,
    decoded: candidate,
    normalized,
    requireExists
  });
  
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.isAbsolute(normalized)) {
    console.log('resolvePdfName: invalid path structure');
    return null;
  }
  if (!normalized.toLowerCase().endsWith(".pdf")) {
    console.log('resolvePdfName: does not end with .pdf');
    return null;
  }

  const abs = path.resolve(path.join(SHEETS_DIR, normalized));
  if (path.relative(SHEETS_DIR, abs).startsWith("..")) {
    console.log('resolvePdfName: path escapes SHEETS_DIR');
    return null;
  }

  if (requireExists) {
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) {
        console.log('resolvePdfName: exists but is not a file');
        return null;
      }
    } catch {
      console.log('resolvePdfName: file does not exist:', abs);
      return null;
    }
  }

  console.log('resolvePdfName: success ->', { rel: normalized, abs });
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
    console.log(`Using cached thumbnail for ${relPdf}`);
    return { thumbPath, thumbStat };
  }

  if (!pdfjsLib || !canvas) {
    console.warn(`PDF.js or Canvas not available for ${relPdf}, using fallback thumbnail`);
    await writeFallbackThumbnail(thumbPath);
    const fallbackStat = await statSafe(thumbPath);
    return { thumbPath, thumbStat: fallbackStat };
  }

  try {
    // console.log(`Creating thumbnail from PDF for ${relPdf}...`);
    await createThumbnailFromPdf(pdfPath, thumbPath, relPdf);
    // console.log(`Thumbnail created successfully for ${relPdf}`);
  } catch (err) {
    console.error(`createThumbnailFromPdf failed for ${relPdf}:`, err);
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

/* ---------------- Config persistence (queued writes) ---------------- */
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const j = JSON.parse(raw);
    const favoritesRaw = Array.isArray(j.favorites) ? j.favorites : [];
    
    // Clean up favorites: only keep ones that actually exist as files
    const favorites = favoritesRaw
      .map((name) => {
        const info = resolvePdfName(name, { requireExists: true }); // Changed to requireExists: true
        return info ? info.rel : null;
      })
      .filter(Boolean);
    
    // Auto-cleanup: if some favorites were removed, mark config as dirty to save cleaned version
    const removedCount = favoritesRaw.length - favorites.length;
    const needsCleanup = removedCount > 0;
    if (needsCleanup) {
      // console.log(`[Config] Removed ${removedCount} non-existent favorite(s) from config`);
    }

    const categoriesRaw = Array.isArray(j.categories) ? j.categories : [];
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

    const validCatIds = new Set(categories.map((c) => c.id));

    const files = {};
    if (j.files && typeof j.files === "object") {
      for (const [key, value] of Object.entries(j.files)) {
        const info = resolvePdfName(key, { requireExists: false });
        if (info && value && typeof value === "object") {
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
    }

    const favList = Array.from(new Set(favorites)).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );

    return { favorites: favList, files, categories, needsCleanup };
  } catch {
    return { favorites: [], files: {}, categories: [], needsCleanup: false };
  }
}
let CONFIG = loadConfig();
let _configDirty = CONFIG.needsCleanup || false; // Mark dirty if cleanup happened
let _configVersion = 0;
let _saveInProgress = null;
let configFileState = (() => {
  try {
    const stat = fs.statSync(CONFIG_FILE);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
})();

// Auto-save cleaned config if favorites were removed
if (CONFIG.needsCleanup) {
  delete CONFIG.needsCleanup; // Remove flag before saving
  setTimeout(() => {
    saveConfigImmediate().catch(err => console.error('[Config] Auto-cleanup save failed:', err));
  }, 1000);
}

/* ---------------- Playlist persistence ---------------- */
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
    console.error("ensurePlaylistFile failed:", err);
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

let PLAYLIST_STATE = loadPlaylists();
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

async function savePlaylistsImmediate() {
  if (_playlistSaveInProgress) {
    try { await _playlistSaveInProgress; } catch {}
  }
  const snapshot = serializePlaylistState(PLAYLIST_STATE);
  const task = (async () => {
    try {
      await fs.promises.mkdir(path.dirname(PLAYLISTS_FILE), { recursive: true });
      const tmp = `${PLAYLISTS_FILE}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
      await fs.promises.rename(tmp, PLAYLISTS_FILE);
    } catch (err) {
      console.error("savePlaylistsImmediate failed:", err);
      throw err;
    } finally {
      _playlistSaveInProgress = null;
    }
  })();
  _playlistSaveInProgress = task;
  return task;
}

const playlistActiveClients = new Set();
const playlistStateClients = new Set();

function broadcastPlaylists() {
  const activePayload = `data: ${JSON.stringify(serializeActivePlaylist())}\n\n`;
  const statePayload = `data: ${JSON.stringify(serializePlaylistState(PLAYLIST_STATE))}\n\n`;
  for (const res of playlistActiveClients) {
    try { res.write(activePayload); } catch {}
  }
  for (const res of playlistStateClients) {
    try { res.write(statePayload); } catch {}
  }
}

function updatePlaylistTimestamp(playlist) {
  const now = Date.now();
  playlist.updatedAt = now;
  PLAYLIST_STATE.updatedAt = now;
}

function buildDefaultPlaylistName() {
  const base = "Playlist";
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
  return PLAYLIST_STATE.playlists.find((pl) => pl.id === id) || null;
}

/* ---------------- Playlist API (REST + SSE) ---------------- */
// CRITICAL: JSON body parser middleware must come BEFORE routes that need it
app.use(express.json({ limit: "20mb" }));

app.get("/api/playlists", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(serializePlaylistState(PLAYLIST_STATE));
});
app.get("/api/playlists/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  try { res.write(`data: ${JSON.stringify(serializePlaylistState(PLAYLIST_STATE))}\n\n`); } catch {}
  playlistStateClients.add(res);

  const keepAlive = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch {}
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    playlistStateClients.delete(res);
    try { res.end(); } catch {}
  });
});

// Legacy active playlist endpoints (kept for backwards compatibility)
app.get("/api/playlist", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(serializeActivePlaylist());
});
app.get("/api/playlist/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  try { res.write(`data: ${JSON.stringify(serializeActivePlaylist())}\n\n`); } catch {}
  playlistActiveClients.add(res);

  const keepAlive = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch {}
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    playlistActiveClients.delete(res);
    try { res.end(); } catch {}
  });
});

app.post("/api/playlists", async (req, res) => {
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
  broadcastPlaylists();
  res.status(201).json({ ok: true, playlist: clonePlaylist(playlist), state: serializePlaylistState(PLAYLIST_STATE) });
});

app.post("/api/playlists/:id/activate", async (req, res) => {
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  PLAYLIST_STATE.activeId = playlist.id;
  PLAYLIST_STATE.updatedAt = Date.now();
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists();
  res.json({ ok: true, state: serializePlaylistState(PLAYLIST_STATE) });
});

app.patch("/api/playlists/:id", async (req, res) => {
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
  broadcastPlaylists();
  res.json({ ok: true, playlist: clonePlaylist(playlist) });
});

app.delete("/api/playlists/:id", async (req, res) => {
  const { id } = req.params;
  if (!removePlaylistById(id)) {
    return res.status(404).json({ error: "Playlist not found" });
  }
  ensureActivePlaylistPresent();
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists();
  res.json({ ok: true, state: serializePlaylistState(PLAYLIST_STATE) });
});

app.post("/api/playlists/:id/items/add", async (req, res) => {
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  const { name } = req.body || {};
  const rel = normalizeRelName(name);
  if (!rel) return res.status(400).json({ error: "Invalid file name" });
  const changed = addItemToPlaylist(playlist, rel);
  if (changed) {
    await savePlaylistsImmediate().catch(() => {});
    broadcastPlaylists();
  }
  res.json({ ok: true, playlist: clonePlaylist(playlist) });
});

app.post("/api/playlists/:id/items/remove", async (req, res) => {
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  const { name } = req.body || {};
  const rel = normalizeRelName(name);
  if (!rel) return res.status(400).json({ error: "Invalid file name" });
  const changed = removeItemFromPlaylist(playlist, rel);
  if (changed) {
    await savePlaylistsImmediate().catch(() => {});
    broadcastPlaylists();
  }
  res.json({ ok: true, playlist: clonePlaylist(playlist) });
});

app.post("/api/playlists/:id/items/clear", async (req, res) => {
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  const changed = clearPlaylistItems(playlist);
  if (changed) {
    await savePlaylistsImmediate().catch(() => {});
    broadcastPlaylists();
  }
  res.json({ ok: true, playlist: clonePlaylist(playlist) });
});

app.post("/api/playlists/:id/items/reorder", async (req, res) => {
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: "order must be an array" });
  const normalized = order.map((name) => normalizeRelName(name)).filter(Boolean);
  reorderPlaylistItems(playlist, normalized);
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists();
  res.json({ ok: true, playlist: clonePlaylist(playlist) });
});

app.post("/api/playlists/:id/items/set", async (req, res) => {
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  const { items, currentIndex } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "items must be an array" });
  const normalized = items.map((name) => normalizeRelName(name)).filter(Boolean);
  setPlaylistItems(playlist, normalized, currentIndex);
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists();
  res.json({ ok: true, playlist: clonePlaylist(playlist) });
});

app.post("/api/playlists/:id/items/current", async (req, res) => {
  const { id } = req.params;
  const playlist = findPlaylistOrFail(id);
  if (!playlist) return res.status(404).json({ error: "Playlist not found" });
  const { index } = req.body || {};
  if (!Number.isInteger(index)) return res.status(400).json({ error: "index must be integer" });
  setPlaylistCurrentIndex(playlist, index);
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists();
  res.json({ ok: true, playlist: clonePlaylist(playlist) });
});

app.post("/api/playlists/items/assign", async (req, res) => {
  console.log('========================================');
  console.log('POST /api/playlists/items/assign RECEIVED');
  console.log('req.body type:', typeof req.body);
  console.log('req.body:', req.body);
  console.log('req.body stringified:', JSON.stringify(req.body, null, 2));
  console.log('req.headers["content-type"]:', req.headers['content-type']);
  
  const { name, playlists } = req.body || {};
  
  console.log('Extracted name:', name, 'type:', typeof name);
  console.log('Extracted playlists:', playlists, 'type:', typeof playlists);
  console.log('========================================');
  
  if (!name || typeof name !== 'string') {
    console.warn('VALIDATION FAILED - Invalid or missing name parameter:', name);
    return res.status(400).json({ error: "Invalid or missing file name" });
  }
  
  // Try to normalize the name - be more lenient
  let rel = name.trim();
  
  // If it's already a valid path, use it directly
  // Otherwise try to resolve it
  if (rel && rel.toLowerCase().endsWith('.pdf')) {
    // Basic validation without requiring file to exist
    const normalized = rel.split('\\').join('/'); // Convert backslashes to forward slashes
    
    // Remove any URL encoding
    try {
      rel = decodeURIComponent(normalized);
    } catch {
      rel = normalized;
    }
    
    // Remove leading/trailing slashes
    rel = rel.replace(/^\/+|\/+$/g, '');
    
    console.log('Normalized filename:', rel);
  } else {
    console.warn('Invalid filename format:', name);
    return res.status(400).json({ error: `Invalid file name: ${name}` });
  }
  
  const ids = Array.isArray(playlists) ? playlists.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean) : [];
  
  if (ids.length === 0) {
    console.warn('No valid playlist IDs provided');
    return res.status(400).json({ error: "No playlists selected" });
  }
  
  console.log('Assigning item:', { rel, playlistIds: ids });
  
  const targetSet = new Set(ids);
  let changed = false;

  PLAYLIST_STATE.playlists.forEach((pl) => {
    const has = pl.items.includes(rel);
    const shouldHave = targetSet.has(pl.id);
    if (shouldHave && !has) {
      pl.items.push(rel);
      updatePlaylistTimestamp(pl);
      changed = true;
      console.log(`Added ${rel} to playlist ${pl.name}`);
    } else if (!shouldHave && has) {
      pl.items = pl.items.filter((item) => item !== rel);
      if (pl.currentIndex >= pl.items.length) {
        pl.currentIndex = pl.items.length ? pl.items.length - 1 : -1;
      }
      updatePlaylistTimestamp(pl);
      changed = true;
      console.log(`Removed ${rel} from playlist ${pl.name}`);
    }
  });

  if (changed) {
    await savePlaylistsImmediate().catch((err) => {
      console.error('Failed to save playlists:', err);
    });
    broadcastPlaylists();
    console.log('Playlist assignments saved successfully');
  } else {
    console.log('No changes needed for assignments');
  }

  res.json({ ok: true, state: serializePlaylistState(PLAYLIST_STATE) });
});

// Legacy convenience endpoints targeting the active playlist
app.post("/api/playlist/add", async (req, res) => {
  const active = ensureActivePlaylistPresent();
  const { name } = req.body || {};
  const rel = normalizeRelName(name);
  if (!rel) return res.status(400).json({ error: "Invalid file name" });
  const changed = addItemToPlaylist(active, rel);
  if (changed) {
    await savePlaylistsImmediate().catch(() => {});
    broadcastPlaylists();
  }
  res.json({ ok: true, playlist: serializeActivePlaylist() });
});
app.post("/api/playlist/remove", async (req, res) => {
  const active = ensureActivePlaylistPresent();
  const { name } = req.body || {};
  const rel = normalizeRelName(name);
  if (!rel) return res.status(400).json({ error: "Invalid file name" });
  const changed = removeItemFromPlaylist(active, rel);
  if (changed) {
    await savePlaylistsImmediate().catch(() => {});
    broadcastPlaylists();
  }
  res.json({ ok: true, playlist: serializeActivePlaylist() });
});
app.post("/api/playlist/clear", async (req, res) => {
  const active = ensureActivePlaylistPresent();
  const changed = clearPlaylistItems(active);
  if (changed) {
    await savePlaylistsImmediate().catch(() => {});
    broadcastPlaylists();
  }
  res.json({ ok: true, playlist: serializeActivePlaylist() });
});
app.post("/api/playlist/reorder", async (req, res) => {
  const active = ensureActivePlaylistPresent();
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: "order must be an array" });
  const normalized = order.map((name) => normalizeRelName(name)).filter(Boolean);
  reorderPlaylistItems(active, normalized);
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists();
  res.json({ ok: true, playlist: serializeActivePlaylist() });
});
app.post("/api/playlist", async (req, res) => {
  const active = ensureActivePlaylistPresent();
  const { items, currentIndex, name } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: "items must be an array" });
  if (name !== undefined) active.name = sanitizePlaylistName(name, active.name);
  const normalized = items.map((item) => normalizeRelName(item)).filter(Boolean);
  setPlaylistItems(active, normalized, currentIndex);
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists();
  res.json({ ok: true, playlist: serializeActivePlaylist() });
});
app.post("/api/playlist/current", async (req, res) => {
  const active = ensureActivePlaylistPresent();
  const { index } = req.body || {};
  if (!Number.isInteger(index)) return res.status(400).json({ error: "index must be integer" });
  setPlaylistCurrentIndex(active, index);
  await savePlaylistsImmediate().catch(() => {});
  broadcastPlaylists();
  res.json({ ok: true, playlist: serializeActivePlaylist() });
});

function refreshIndexFromConfig() {
  if (!indexCache || !Array.isArray(indexCache.items) || !indexCache.items.length) return;
  indexCache.items = indexCache.items.map((item) => {
    if (!item || !item.name) return item;
    const fileCfg = CONFIG.files[item.name] || {};
    const catIds = sanitizeCategoryIds(fileCfg.categories || []);
    const categoriesDetailed = catIds
      .map((id) => {
        const cat = getCategoryById(id);
        return cat ? { ...cat } : null;
      })
      .filter(Boolean);
    return { ...item, categoryIds: catIds, categories: categoriesDetailed };
  });
}

async function ensureConfigFresh() {
  if (_configDirty) return;
  if (_saveInProgress) {
    try {
      await _saveInProgress;
    } catch {
      // ignore write errors here; stat below will re-evaluate
    }
  }
  try {
    const stat = await fs.promises.stat(CONFIG_FILE);
    const changed = !configFileState || stat.mtimeMs !== configFileState.mtimeMs || stat.size !== configFileState.size;
    if (!changed) return;
    CONFIG = loadConfig();
    configFileState = { mtimeMs: stat.mtimeMs, size: stat.size };
    refreshIndexFromConfig();
    _configDirty = false;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      CONFIG = { favorites: [], files: {}, categories: [] };
      configFileState = null;
      refreshIndexFromConfig();
      _configDirty = false;
    } else {
      console.error("ensureConfigFresh failed:", err);
    }
  }
}

function markConfigDirty() {
  _configDirty = true;
  _configVersion = (_configVersion + 1) >>> 0; // wrap safely within 32 bits
}

async function saveConfigImmediate() {
  if (_saveInProgress) {
    try {
      await _saveInProgress;
    } catch (e) {
      // ignore and attempt fresh save below
    }
  }

  if (!_configDirty && !_saveInProgress) {
    return;
  }

  const saveVersion = _configVersion;

  const task = (async () => {
    try {
      await fs.promises.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
      const tmp = CONFIG_FILE + ".tmp";
      await fs.promises.writeFile(tmp, JSON.stringify(CONFIG, null, 2), "utf8");
      await fs.promises.rename(tmp, CONFIG_FILE);
      try {
        const stat = await fs.promises.stat(CONFIG_FILE);
        configFileState = { mtimeMs: stat.mtimeMs, size: stat.size };
      } catch (statErr) {
        console.warn("Unable to stat config after save:", statErr?.message || statErr);
      }
      if (_configVersion === saveVersion) {
        _configDirty = false;
      }
      // console.log("Config persisted", { favorites: CONFIG.favorites.length, files: Object.keys(CONFIG.files).length });
    } catch (e) {
      _configDirty = true;
      console.error("saveConfigImmediate failed:", e);
      throw e;
    } finally {
      _saveInProgress = null;
    }
  })();

  _saveInProgress = task;
  return task;
}

async function persistConfigNow() {
  markConfigDirty();
  try {
    await saveConfigImmediate();
  } catch (err) {
    console.error("persistConfigNow failed:", err);
    try {
      CONFIG = loadConfig();
      const stat = await fs.promises.stat(CONFIG_FILE).catch(() => null);
      if (stat) {
        configFileState = { mtimeMs: stat.mtimeMs, size: stat.size };
      }
      refreshIndexFromConfig();
      _configDirty = false;
    } catch (reloadErr) {
      console.error("persistConfigNow reload failed:", reloadErr);
    }
    throw err;
  }
}

async function flushConfigBeforeExit() {
  if (_saveInProgress) {
    try {
      await _saveInProgress;
    } catch (e) {
      console.error("Pending config save failed during shutdown:", e);
    }
  }

  if (_configDirty) {
    try {
      await saveConfigImmediate();
    } catch (e) {
      console.error("Final config save failed:", e);
    }
  }
}

function isValidPdfName(name) {
  return Boolean(resolvePdfName(name));
}

/* ---------------- App-level middlewares (optimized) ---------------- */
if (helmet) {
  app.use(helmet({
    // Avoid CSP here to not break inline module script in index.html
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
}

if (compression && MEMORY_SETTINGS.enableGzipCompression) {
  app.use(compression({
    level: 6, // Balanced compression level
    threshold: 1024, // Only compress files > 1KB
    filter: (req, res) => {
      // Don't compress PDFs or already compressed content
      if (req.path.startsWith('/sheets/')) return false;
      return compression.filter(req, res);
    }
  }));
}

if (morgan) app.use(morgan("tiny"));

// NOTE: express.json() middleware is now placed BEFORE API routes (see line ~1415)

// Add memory monitoring middleware
/* ---------------- Front-end (SPA) ---------------- */
app.use(express.static(PUBLIC_DIR, { etag: true, lastModified: true, maxAge: "1d" }));

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
    console.error("Thumbnail serve error:", error);
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
let indexCache = { at: 0, items: [], scanInProgress: false };

async function statSafe(full) {
  try { return await fs.promises.stat(full); } catch { return null; }
}

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
        const fileCfg = CONFIG.files[rel] || {};
        const catIds = sanitizeCategoryIds(fileCfg.categories || []);
        const categoriesDetailed = catIds
          .map((id) => {
            const cat = getCategoryById(id);
            return cat ? { ...cat } : null;
          })
          .filter(Boolean);

        results.push({
          id: encodeURIComponent(rel),
          name: rel,
          displayName,
          folder,
          url: `/sheets/${encodedRel}`,
          thumbnail: `/thumbnails/${encodedThumb}`,
          size: st.size,
          mtime: st.mtimeMs,
          categoryIds: catIds,
          categories: categoriesDetailed,
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

/* ---------------- Memory & System API ---------------- */
app.get("/api/system/memory", (req, res) => {
  try {
    const mem = process.memoryUsage();
    const heapUsed = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotal = Math.round(mem.heapTotal / 1024 / 1024);
    const external = Math.round(mem.external / 1024 / 1024);
    
    res.json({
      heapUsed,
      heapTotal,
      external,
      uptime: Math.round(process.uptime()),
      cacheSize: indexCache.items.length,
      lastScan: indexCache.at ? new Date(indexCache.at).toISOString() : null
    });
  } catch (e) {
    res.status(500).json({ error: "Memory info unavailable" });
  }
});

app.post("/api/system/gc", (req, res) => {
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

function withAnnotationLock(rel, task) {
  const prev = annotationLocks.get(rel) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => task())
    .finally(() => {
      if (annotationLocks.get(rel) === next) {
        annotationLocks.delete(rel);
      }
    });
  annotationLocks.set(rel, next);
  return next;
}

/* ---------------- Sheets API (enhanced with pagination) ---------------- */
app.get("/api/sheets", async (req, res) => {
  try {
    await ensureConfigFresh();
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
    let filtered = all;

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
app.post("/api/upload", async (req, res) => {
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
  const baseName = path.basename(rawName || "upload", path.extname(rawName || "") || ".pdf");
  const finalName = generateUniquePdfFilename(baseName || "sheet");
  const finalPath = path.join(SHEETS_DIR, finalName);
  const rel = toPosixPath(finalName);
  const tempName = `.${Date.now()}-${Math.round(Math.random() * 1e6)}-${finalName}`;
  const tempPath = path.join(SHEETS_DIR, tempName);

  try {
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
  } catch (err) {
    console.error("Upload mkdir failed:", err);
    return res.status(500).json({ error: "Upload konnte nicht vorbereitet werden" });
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
    console.error("Upload stream failed:", err);
    return res.status(400).json({ error: "Upload fehlgeschlagen" });
  }

  try {
    await fs.promises.rename(tempPath, finalPath);
  } catch (err) {
    await fs.promises.unlink(tempPath).catch(() => {});
    console.error("Upload rename failed:", err);
    return res.status(500).json({ error: "Upload konnte nicht gespeichert werden" });
  }

  const cleanupFile = async () => {
    await fs.promises.unlink(finalPath).catch(() => {});
    const thumbPath = path.join(THUMBS_DIR, thumbnailRelPath(rel));
    await fs.promises.unlink(thumbPath).catch(() => {});
  };

  try {
    await ensureConfigFresh();
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
      console.error("Thumbnail generation failed for upload:", rel, thumbErr);
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

    markConfigDirty();
    try {
      await saveConfigImmediate();
    } catch (saveErr) {
      console.error("Failed to persist config after upload:", saveErr);
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
  await ensureConfigFresh();
  res.setHeader("Cache-Control", "no-store");
  res.json(CONFIG);
});

app.post("/api/prefs/favorites", async (req, res) => {
  const { name, favorite } = req.body || {};
  const info = resolvePdfName(name);
  if (!info) return res.status(400).json({ error: "Invalid file name" });
  await ensureConfigFresh();
  
  const originalFavorites = [...CONFIG.favorites];
  const set = new Set(CONFIG.favorites);
  if (favorite) set.add(info.rel); else set.delete(info.rel);
  CONFIG.favorites = Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  
  try {
    await persistConfigNow();
  } catch (err) {
    CONFIG.favorites = originalFavorites;
    console.error("Failed to persist favorites:", err);
    return res.status(500).json({ error: "Failed to persist favorites" });
  }
  res.json({ ok: true, favorites: CONFIG.favorites });
});

app.get("/api/prefs/file", async (req, res) => {
  const name = (req.query.name || "").toString();
  const info = resolvePdfName(name, { requireExists: false });
  if (!info) return res.status(400).json({ error: "Invalid file name" });
  await ensureConfigFresh();
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
  const { name, secsPerPage, categories, jumpMarkers } = req.body || {};
  const info = resolvePdfName(name);
  if (!info) return res.status(400).json({ error: "Invalid file name" });

  await ensureConfigFresh();
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
    await persistConfigNow();
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
  const name = (req.query.name || "").toString();
  const info = resolvePdfName(name);
  if (!info) {
    return res.status(400).json({ error: "Invalid file name" });
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
  const { name, overlays } = req.body || {};
  const info = resolvePdfName(name);
  if (!info) {
    return res.status(400).json({ error: "Invalid file name" });
  }

  if (!Array.isArray(overlays)) {
    return res.status(400).json({ error: "No overlays provided" });
  }

  try {
    await withAnnotationLock(info.rel, async () => {
      await ensureAnnotationStore(info.rel);
      const index = await loadAnnotationIndex(info.rel);
      const pages = index.pages;
      let didUpdate = false;
      let snapshot = null;

      try {
        snapshot = await createAnnotationSnapshot(info, index);
      } catch (snapshotErr) {
        console.warn(
          "Failed to capture annotation snapshot before save",
          info.rel,
          snapshotErr?.message || snapshotErr
        );
      }

      try {
        for (const raw of overlays) {
          if (!raw || typeof raw !== "object") continue;
          const pageNumber = Number(raw.pageNumber);
          if (!Number.isInteger(pageNumber) || pageNumber < 1) continue;
          const dataUrl = typeof raw.dataUrl === "string" ? raw.dataUrl.trim() : "";
          const hasData = dataUrl.startsWith("data:image/png;base64,") && dataUrl.length > "data:image/png;base64,".length;
          const pageWidth = Number(raw.pageWidth);
          const pageHeight = Number(raw.pageHeight);
          const meta = {};
          if (Number.isFinite(pageWidth) && pageWidth > 0) meta.pageWidth = pageWidth;
          if (Number.isFinite(pageHeight) && pageHeight > 0) meta.pageHeight = pageHeight;

          const pagePath = getAnnotationPagePath(info.rel, pageNumber);

          if (hasData) {
            const base64 = dataUrl.slice("data:image/png;base64,".length);
            const buffer = Buffer.from(base64, "base64");
            if (!buffer.length) continue;
            await fs.promises.writeFile(pagePath, buffer);
            pages[pageNumber] = { ...pages[pageNumber], ...meta, updatedAt: Date.now() };
            didUpdate = true;
          } else {
            try {
              await fs.promises.unlink(pagePath);
            } catch {}
            if (pages[pageNumber]) {
              delete pages[pageNumber];
              didUpdate = true;
            }
          }
        }

        if (!didUpdate) {
          await discardAnnotationSnapshot(snapshot);
          return;
        }

        await saveAnnotationIndex(info.rel, index);
        await rebuildPdfFromAnnotations(info, index);
        await finalizeAnnotationSnapshot(snapshot);
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
    console.error("Annotation save failed:", err);
    res.status(500).json({ error: "Failed to apply annotations" });
  }
});

app.post("/api/annotations/undo", async (req, res) => {
  const { name } = req.body || {};
  const info = resolvePdfName(name);
  if (!info) {
    return res.status(400).json({ error: "Invalid file name" });
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
  const { name } = req.body || {};
  const info = resolvePdfName(name);
  if (!info) {
    return res.status(400).json({ error: "Invalid file name" });
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
  await ensureConfigFresh();
  res.setHeader("Cache-Control", "no-store");
  res.json({ categories: CONFIG.categories.map((cat) => ({ ...cat })) });
});

app.post("/api/categories", async (req, res) => {
  const { name, color, icon } = req.body || {};
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName) {
    return res.status(400).json({ error: "Name required" });
  }

  await ensureConfigFresh();
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
    await persistConfigNow();
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
  const id = (req.params.id || "").toString();

  await ensureConfigFresh();
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
    await persistConfigNow();
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
  const id = (req.params.id || "").toString();
  await ensureConfigFresh();
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
    await persistConfigNow();
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

/* ---------------- Health & SPA fallback ---------------- */
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

app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

let server = null;
let sheetWatcher = null;
(async () => {
  try { 
    await ensureVendors(); 
  } catch { 
    console.warn("Vendor prefetch failed – will lazy-fetch on demand"); 
  }
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
  if (_configDirty || _saveInProgress) {
    flushConfigBeforeExit().catch((err) => {
      console.error("beforeExit flush failed:", err);
    });
  }
});
process.on("uncaughtException", (e) => { console.error("uncaughtException", e); });
process.on("unhandledRejection", (e) => { console.error("unhandledRejection", e); });
