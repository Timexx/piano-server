// server.js — Piano Sheets (server-side thumbnail generation for performance)

const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");

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
const THUMBS_DIR = path.join(DATA_DIR, "thumbnails"); // New: thumbnail cache directory
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
      if (!filtered.length && !cfg.secsPerPage) {
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
  thumbnailSize: 200,        // Thumbnail width in pixels
  thumbnailQuality: 80,      // JPEG quality for thumbnails
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
  if (typeof name !== "string") return null;

  let candidate = name.trim();
  if (!candidate) return null;
  try { candidate = decodeURIComponent(candidate); } catch {}

  const normalized = path.posix.normalize(toPosixPath(candidate));
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.isAbsolute(normalized)) {
    return null;
  }
  if (!normalized.toLowerCase().endsWith(".pdf")) return null;

  const abs = path.resolve(path.join(SHEETS_DIR, normalized));
  if (path.relative(SHEETS_DIR, abs).startsWith("..")) return null;

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
    console.log(`Creating thumbnail from PDF for ${relPdf}...`);
    await createThumbnailFromPdf(pdfPath, thumbPath, relPdf);
    console.log(`Thumbnail created successfully for ${relPdf}`);
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

  console.log(`Generated thumbnail for: ${relPdf}`);
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
    const favorites = favoritesRaw
      .map((name) => {
        const info = resolvePdfName(name, { requireExists: false });
        return info ? info.rel : null;
      })
      .filter(Boolean);

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
          if (Object.keys(entry).length) {
            files[info.rel] = entry;
          }
        }
      }
    }

    const favList = Array.from(new Set(favorites)).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );

    return { favorites: favList, files, categories };
  } catch {
    return { favorites: [], files: {}, categories: [] };
  }
}
let CONFIG = loadConfig();
let _configDirty = false;
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
      console.log("Config persisted", { favorites: CONFIG.favorites.length, files: Object.keys(CONFIG.files).length });
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

app.use(express.json({ limit: "256kb" }));

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
  try {
    const requested = toPosixPath(req.params[0] || "");
    if (!requested || !/\.(jpg|jpeg|png)$/i.test(requested)) {
      return res.status(400).json({ error: "Invalid thumbnail path" });
    }

    const pdfRel = requested.replace(/\.(jpg|jpeg|png)$/i, ".pdf");
    const info = resolvePdfName(pdfRel);
    if (!info) {
      return res.status(404).json({ error: "PDF not found" });
    }

    const { thumbPath, thumbStat } = await ensureThumbnail(info);
    if (!thumbStat) {
      return res.status(500).json({ error: "Thumbnail unavailable" });
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

    return fs.createReadStream(thumbPath).pipe(res);
  } catch (error) {
    console.error("Thumbnail serve error:", error);
    res.status(500).json({ error: "Thumbnail generation failed" });
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
    maxAge: "7d",
    etag: true,
    lastModified: true,
    dotfiles: 'deny',
    setHeaders(res, filePath) {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "public, max-age=604800");
      
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

    console.log(`Scanned ${items.length} PDF files (recursive)`);
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

/* ---------------- Sheets API (enhanced with pagination) ---------------- */
app.get("/api/sheets", async (req, res) => {
  try {
    await ensureConfigFresh();
    const q = (req.query.q || "").toString().trim().toLowerCase();
    const sort = (req.query.sort || "name").toString();
    const order = (req.query.order || "asc").toString();
    const categoryParam = req.query.category ?? req.query.categories;

    const categoryFilters = (() => {
      if (!categoryParam) return [];
      const raw = Array.isArray(categoryParam) ? categoryParam : [categoryParam];
      const parts = raw
        .flatMap((value) => value.toString().split(/[,;\s]+/))
        .map((value) => value.trim())
        .filter(Boolean);
      return sanitizeCategoryIds(parts);
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
    if (categoryFilterSet.size) {
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
  const metaHeader = req.headers["x-upload-meta"];
  let meta = {};
  if (metaHeader) {
    try {
      meta = JSON.parse(metaHeader.toString());
    } catch {
      return res.status(400).json({ error: "Ungültige Upload-Metadaten" });
    }
  }
  if (!meta || typeof meta !== "object") meta = {};

  const headerName = typeof req.headers["x-upload-name"] === "string" ? req.headers["x-upload-name"].trim() : "";
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
  res.json({ name: info.rel, secsPerPage: entry.secsPerPage || null, categories, categoryIds });
});

app.post("/api/prefs/file", async (req, res) => {
  const { name, secsPerPage, categories } = req.body || {};
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
  res.json({ ok: true, name: info.rel, secsPerPage: latestEntry.secsPerPage || null, categories: categoriesMeta, categoryIds });
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