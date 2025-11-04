// server.js — Piano Sheets (Refactored with User Context & DataStore)

const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const { randomUUID } = require("crypto");
const { PDFDocument } = require("pdf-lib");
const { createAuthService } = require("./lib/auth");
const { createDataStore } = require("./lib/data-store");
const { createUserContextMiddleware } = require("./lib/user-context-middleware");
const { UserSSEManager, createSSEEndpoint } = require("./lib/user-sse-manager");

// Optional middlewares
let helmet = null, morgan = null, compression = null;
try { helmet = require("helmet"); } catch {}
try { morgan = require("morgan"); } catch {}
try { compression = require("compression"); } catch {}

// PDF processing libraries
let pdfjsLib = null, sharp = null, canvas = null;
try {
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

// Directories
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const SHEETS_DIR = path.join(ROOT, "sheets");
const DATA_DIR = path.join(ROOT, "data");
const THUMBS_DIR = path.join(DATA_DIR, "thumbnails");
const ANNOTATIONS_DIR = path.join(DATA_DIR, "annotations");
const VENDOR_DIR = path.join(DATA_DIR, "vendor");
const MAX_ANNOTATION_VERSIONS = 20;
const CPU_COUNT = Math.max(1, typeof os.cpus === "function" ? os.cpus().length : 1);

// Constants
const DEFAULT_CATEGORY_COLOR = "#6366F1";
const FALLBACK_THUMB_BUFFER = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEhUTEhIVFRUVFxUXFhUVFxcYFRUVFRUXFxcYHSggGBolGxUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGxAQGy0lICUtNS0tLS0tLy0tLS0tLS0vLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tKy0tLS0tLS0tLf/AABEIAKgBLAMBIgACEQEDEQH/xAAbAAACAgMBAAAAAAAAAAAAAAADBAIFAQAGB//EADYQAAEDAgMFBQcEAgIDAAAAAAEAAgMEEQUSIRMxQVFhBhQicYEykaGxwdHwFCMzUvEkUmLR4fEjM1PSFiRT/8QAGQEBAAMBAQAAAAAAAAAAAAAAAAECAwQF/8QAJxEBAAICAgIBAwQDAAAAAAAAAAECAxEEIRIxQRNRYSJxBRRxkbH/2gAMAwEAAhEDEQA/AO6iIiAiIgIiICIiAiIgIiICIiAiIgIiICIiAiIgIiICIiAiIgIiICIiAiIgI//2Q==",
  "base64"
);
const SESSION_COOKIE_NAME = "ps_session";
const SESSION_RENEW_THRESHOLD_MS = 1000 * 60 * 60 * 24; // 24 hours
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB

// Memory settings
const MEMORY_SETTINGS = {
  maxIndexCacheAge: 300000,
  maxVendorRetries: 3,
  maxStatConcurrency: 32,
  enableGzipCompression: true,
  thumbnailSize: 600,
  thumbnailQuality: 100,
  maxThumbnailAge: 7 * 24 * 60 * 60 * 1000
};

// Vendor CDN URLs
const PDFJS_DIR = path.join(VENDOR_DIR, "pdfjs");
const PDFJS_VER = "3.11.174";
const VENDORS = {
  "pdfjs/pdf.min.js": `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.min.js`,
  "pdfjs/pdf.worker.min.js": `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.worker.min.js`,
  "fuse.min.js": "https://cdnjs.cloudflare.com/ajax/libs/fuse.js/7.0.0/fuse.min.js",
  "nosleep.min.js": "https://cdn.jsdelivr.net/npm/nosleep.js@0.12.0/dist/NoSleep.min.js",
};

// Ensure directories exist
fs.mkdirSync(SHEETS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(VENDOR_DIR, { recursive: true });
fs.mkdirSync(PDFJS_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });

// Global services (initialized on startup)
let server = null;
let authService = null;
let dataStore = null;
let userContext = null;
let sseManager = null;
let sheetWatcher = null;

// Index cache
let indexCache = { at: 0, items: [], scanInProgress: false };

// Annotation locks
const annotationLocks = new Map();

// Stream helper for size limiting
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

// Continue with utility functions in next part...
