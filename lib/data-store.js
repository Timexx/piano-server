const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function nowIso() {
  return new Date().toISOString();
}

function clone(value, fallback = {}) {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch {
    return JSON.parse(JSON.stringify(fallback));
  }
}

function buildPlaceholders(values) {
  if (!values.length) return "";
  return values.map(() => "?").join(", ");
}

async function createDataStore({ authService, dataDir, sheetsDir, logger = console }) {
  if (!authService || typeof authService.transactional !== "function" || !authService.query) {
    throw new Error("authService with transactional/query helpers is required");
  }
  if (!dataDir) {
    throw new Error("dataDir is required");
  }
  if (!sheetsDir) {
    throw new Error("sheetsDir is required");
  }

  const DEFAULT_CONFIG = { favorites: [], files: {}, categories: [] };
  const DEFAULT_PLAYLIST_STATE = {
    activeId: null,
    updatedAt: Date.now(),
    playlists: [],
  };

  const { transactional, query } = authService;

  async function getUserConfig(userId) {
    const row = query.get(
      `SELECT data FROM user_configs WHERE user_id = ?`,
      [userId]
    );
    if (!row || !row.data) {
      return clone(DEFAULT_CONFIG);
    }
    try {
      return clone(JSON.parse(row.data), DEFAULT_CONFIG);
    } catch (err) {
      logger.warn?.("config parse failed for user", userId, err?.message || err);
      return clone(DEFAULT_CONFIG);
    }
  }

  async function saveUserConfig(userId, config) {
    const payload = JSON.stringify(config ?? DEFAULT_CONFIG);
    const ts = nowIso();
    transactional(({ run }) => {
      run(
        `INSERT INTO user_configs (user_id, data, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        [userId, payload, ts]
      );
    });
  }

  async function getUserPlaylists(userId) {
    const row = query.get(
      `SELECT data FROM user_playlists WHERE user_id = ?`,
      [userId]
    );
    if (!row || !row.data) {
      return clone(DEFAULT_PLAYLIST_STATE);
    }
    try {
      return clone(JSON.parse(row.data), DEFAULT_PLAYLIST_STATE);
    } catch (err) {
      logger.warn?.("playlist parse failed for user", userId, err?.message || err);
      return clone(DEFAULT_PLAYLIST_STATE);
    }
  }

  async function saveUserPlaylists(userId, state) {
    const payload = JSON.stringify(state ?? DEFAULT_PLAYLIST_STATE);
    const ts = nowIso();
    transactional(({ run }) => {
      run(
        `INSERT INTO user_playlists (user_id, data, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        [userId, payload, ts]
      );
    });
  }

  function ensureDocuments(relPaths) {
    if (!Array.isArray(relPaths) || !relPaths.length) {
      return new Map();
    }
    const unique = Array.from(new Set(relPaths.filter((rel) => typeof rel === "string" && rel.trim())));
    if (!unique.length) {
      return new Map();
    }

    const existingMap = new Map();
    const placeholders = buildPlaceholders(unique);
    if (placeholders) {
      const rows = query.all(
        `SELECT id, rel_path FROM documents WHERE rel_path IN (${placeholders})`,
        unique
      );
      rows.forEach((row) => {
        existingMap.set(row.rel_path, row.id);
      });
    }

    const missing = unique.filter((rel) => !existingMap.has(rel));
    if (missing.length) {
      transactional(({ run }) => {
        missing.forEach((rel) => {
          const id = crypto.randomUUID();
          const ts = nowIso();
          run(
            `INSERT INTO documents (id, rel_path, created_at, updated_at) VALUES (?, ?, ?, ?)`,
            [id, rel, ts, ts]
          );
          existingMap.set(rel, id);
        });
      });
    }

    return existingMap;
  }

  function assignDocumentsToUser(userId, relPaths, role = "owner") {
    if (!Array.isArray(relPaths) || !relPaths.length) return;
    const docsMap = ensureDocuments(relPaths);
    const ts = nowIso();
    transactional(({ run }) => {
      for (const [rel, docId] of docsMap.entries()) {
        run(
          `INSERT INTO user_documents (user_id, document_id, access_role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, document_id) DO UPDATE SET access_role = excluded.access_role, updated_at = excluded.updated_at`,
          [userId, docId, role, ts, ts]
        );
      }
    });
  }

  function listUserDocumentRelPaths(userId) {
    const rows = query.all(
      `SELECT d.rel_path
       FROM user_documents ud
       JOIN documents d ON d.id = ud.document_id
       WHERE ud.user_id = ?`,
      [userId]
    );
    return rows.map((row) => row.rel_path);
  }

  function listOwnedDocumentRelPaths(userId) {
    const rows = query.all(
      `SELECT d.rel_path
       FROM user_documents ud
       JOIN documents d ON d.id = ud.document_id
       WHERE ud.user_id = ? AND ud.access_role = 'owner'`,
      [userId]
    );
    return rows.map((row) => row.rel_path);
  }

  function scanSheetsDir() {
    const discovered = [];
    const stack = [""];
    while (stack.length) {
      const relDir = stack.pop();
      const absDir = path.join(sheetsDir, relDir);
      let entries = [];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry || entry.name === "." || entry.name === "..") continue;
        if (entry.name.startsWith(".")) continue;
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          stack.push(relPath);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
          discovered.push(relPath.replace(/\\/g, "/"));
        }
      }
    }
    return discovered;
  }

  async function ensureInitialMigration() {
    const applied = query.get(
      `SELECT key FROM migrations WHERE key = ?`,
      ["initial-json-import"]
    );
    if (applied) return;

    const users = authService.listUsers?.() || [];
    const adminUser = users.find((u) => u.role === "admin" && u.isActive) || users[0];
    if (!adminUser) {
      throw new Error("No users available to assign migrated data.");
    }

    const configFile = path.join(dataDir, "config.json");
    let rawConfig = null;
    if (fs.existsSync(configFile)) {
      try {
        const content = fs.readFileSync(configFile, "utf8");
        rawConfig = JSON.parse(content);
      } catch (err) {
        logger.warn?.("Failed to parse config.json during migration:", err?.message || err);
      }
    }

    const playlistsFile = path.join(dataDir, "playlists.json");
    let rawPlaylists = null;
    if (fs.existsSync(playlistsFile)) {
      try {
        const content = fs.readFileSync(playlistsFile, "utf8");
        rawPlaylists = JSON.parse(content);
      } catch (err) {
        logger.warn?.("Failed to parse playlists.json during migration:", err?.message || err);
      }
    }

    // Persist config + playlists for admin user
    if (rawConfig) {
      await saveUserConfig(adminUser.id, rawConfig);
    } else {
      await saveUserConfig(adminUser.id, DEFAULT_CONFIG);
    }
    if (rawPlaylists) {
      await saveUserPlaylists(adminUser.id, rawPlaylists);
    } else {
      await saveUserPlaylists(adminUser.id, DEFAULT_PLAYLIST_STATE);
    }

    // Assign documents to admin
    const docSet = new Set();
    if (rawConfig) {
      if (Array.isArray(rawConfig.favorites)) {
        rawConfig.favorites.forEach((rel) => {
          if (typeof rel === "string") docSet.add(rel);
        });
      }
      if (rawConfig.files && typeof rawConfig.files === "object") {
        Object.keys(rawConfig.files).forEach((rel) => {
          if (typeof rel === "string") docSet.add(rel);
        });
      }
    }
    if (rawPlaylists && Array.isArray(rawPlaylists.playlists)) {
      rawPlaylists.playlists.forEach((playlist) => {
        if (!playlist || typeof playlist !== "object") return;
        if (Array.isArray(playlist.items)) {
          playlist.items.forEach((rel) => {
            if (typeof rel === "string") docSet.add(rel);
          });
        }
      });
    }

    // include every PDF from sheets dir
    try {
      const discovered = scanSheetsDir();
      discovered.forEach((rel) => docSet.add(rel));
    } catch (err) {
      logger.warn?.("Failed to scan sheets directory during migration:", err?.message || err);
    }

    if (docSet.size) {
      assignDocumentsToUser(adminUser.id, Array.from(docSet), "owner");
    }

    transactional(({ run }) => {
      run(
        `INSERT INTO migrations (key, applied_at, payload) VALUES (?, ?, ?)`,
        ["initial-json-import", nowIso(), JSON.stringify({ adminUserId: adminUser.id })]
      );
    });

    const backupSuffix = `.bak-${Date.now()}`;
    try {
      if (rawConfig) {
        fs.renameSync(configFile, `${configFile}${backupSuffix}`);
      }
    } catch {}
    try {
      if (rawPlaylists) {
        fs.renameSync(playlistsFile, `${playlistsFile}${backupSuffix}`);
      }
    } catch {}

    logger.info?.("Initial JSON data migrated into database for user", adminUser.email || adminUser.id);
  }

  return {
    getUserConfig,
    saveUserConfig,
    getUserPlaylists,
    saveUserPlaylists,
    listUserDocumentRelPaths,
    listOwnedDocumentRelPaths,
    assignDocumentsToUser,
    ensureInitialMigration,
    scanSheetsDir, // exposed for reuse if needed
  };
}

module.exports = {
  createDataStore,
};
