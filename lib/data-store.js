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

  const DEFAULT_CONFIG = {
    favorites: [],
    files: {},
    categories: [],
    annotations: {
      preset: null,
      inputMode: "pen-only"
    },
    library: {
      quickAccess: {
        recentCollapsed: false
      }
    }
  };
  const DEFAULT_PLAYLIST_STATE = {
    activeId: null,
    updatedAt: Date.now(),
    playlists: [],
  };

  const { transactional, query } = authService;

  function mergeConfigDefaults(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const merged = { ...DEFAULT_CONFIG, ...source };
    merged.annotations = {
      ...DEFAULT_CONFIG.annotations,
      ...(source.annotations && typeof source.annotations === "object" ? source.annotations : {})
    };
    const librarySource = source.library && typeof source.library === "object" ? source.library : {};
    merged.library = { ...DEFAULT_CONFIG.library, ...librarySource };
    const quickAccessSource = librarySource.quickAccess && typeof librarySource.quickAccess === "object"
      ? librarySource.quickAccess
      : {};
    merged.library.quickAccess = {
      ...DEFAULT_CONFIG.library.quickAccess,
      ...quickAccessSource
    };
    return merged;
  }

  async function getUserConfig(userId) {
    const row = query.get(
      `SELECT data FROM user_configs WHERE user_id = ?`,
      [userId]
    );
    if (!row || !row.data) {
      return clone(DEFAULT_CONFIG);
    }
    try {
      const parsed = JSON.parse(row.data);
      return mergeConfigDefaults(parsed);
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
    
    // SECURITY: Prevent SQL injection via array size - batch large arrays
    // SQLite has a limit on the number of placeholders (default: 999)
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

    const missing = unique.filter((rel) => !existingMap.has(rel));
    if (missing.length) {
      // SECURITY: Batch inserts as well to prevent transaction size issues
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

  function removeDocumentsFromUser(userId, relPaths) {
    if (!Array.isArray(relPaths) || !relPaths.length) return;
    const unique = Array.from(new Set(relPaths.filter((rel) => typeof rel === "string" && rel.trim())));
    if (!unique.length) return;
    const placeholders = buildPlaceholders(unique);
    const rows = query.all(
      `SELECT id FROM documents WHERE rel_path IN (${placeholders})`,
      unique
    );
    if (!rows.length) return;
    const ids = rows.map((row) => row.id);
    const idPlaceholders = buildPlaceholders(ids);
    transactional(({ run }) => {
      run(
        `DELETE FROM user_documents WHERE user_id = ? AND document_id IN (${idPlaceholders})`,
        [userId, ...ids]
      );
      run(
        `DELETE FROM document_shares WHERE target_user_id = ? AND document_id IN (${idPlaceholders})`,
        [userId, ...ids]
      );
    });
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

  function shareDocument(ownerUserId, relPath, targetUserIds) {
    if (!Array.isArray(targetUserIds) || !targetUserIds.length) return;
    const docsMap = ensureDocuments([relPath]);
    const docId = docsMap.get(relPath);
    if (!docId) throw new Error('Document not found');
    
    // Verify owner has access
    const ownerAccess = query.get(
      `SELECT access_role FROM user_documents WHERE user_id = ? AND document_id = ?`,
      [ownerUserId, docId]
    );
    if (!ownerAccess || ownerAccess.access_role !== 'owner') {
      throw new Error('Only document owner can share');
    }
    
    const ts = nowIso();
    transactional(({ run }) => {
      targetUserIds.forEach((targetUserId) => {
        // Create share record
        const shareId = crypto.randomUUID();
        run(
          `INSERT INTO document_shares (id, document_id, owner_user_id, target_user_id, permissions, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(document_id, owner_user_id, target_user_id) DO UPDATE SET updated_at = excluded.updated_at`,
          [shareId, docId, ownerUserId, targetUserId, 'read', ts, ts]
        );
        
        // Give target user access
        run(
          `INSERT INTO user_documents (user_id, document_id, access_role, created_at, updated_at)
           VALUES (?, ?, 'shared', ?, ?)
           ON CONFLICT(user_id, document_id) DO UPDATE SET updated_at = excluded.updated_at`,
          [targetUserId, docId, ts, ts]
        );
      });
    });
  }

  function unshareDocument(ownerUserId, relPath, targetUserIds) {
    if (!Array.isArray(targetUserIds) || !targetUserIds.length) return;
    const docsMap = ensureDocuments([relPath]);
    const docId = docsMap.get(relPath);
    if (!docId) return;
    
    transactional(({ run }) => {
      targetUserIds.forEach((targetUserId) => {
        // Remove share record
        run(
          `DELETE FROM document_shares WHERE document_id = ? AND owner_user_id = ? AND target_user_id = ?`,
          [docId, ownerUserId, targetUserId]
        );
        
        // Remove user access if no other shares exist
        const remainingShares = query.get(
          `SELECT COUNT(*) as count FROM document_shares WHERE document_id = ? AND target_user_id = ?`,
          [docId, targetUserId]
        );
        if (remainingShares.count === 0) {
          run(
            `DELETE FROM user_documents WHERE user_id = ? AND document_id = ? AND access_role = 'shared'`,
            [targetUserId, docId]
          );
        }
      });
    });
  }

  function removeSelfFromSharedDocument(userId, relPath) {
    const docsMap = ensureDocuments([relPath]);
    const docId = docsMap.get(relPath);
    if (!docId) return;
    
    transactional(({ run }) => {
      // Remove all shares targeting this user for this document
      run(
        `DELETE FROM document_shares WHERE document_id = ? AND target_user_id = ?`,
        [docId, userId]
      );
      
      // Remove user access
      run(
        `DELETE FROM user_documents WHERE user_id = ? AND document_id = ? AND access_role = 'shared'`,
        [userId, docId]
      );
    });
  }

  function getDocumentShareInfo(relPath) {
    const docsMap = ensureDocuments([relPath]);
    const docId = docsMap.get(relPath);
    if (!docId) return { ownerId: null, sharedWith: [], sharedBy: null };
    
    // Get owner
    const ownerRow = query.get(
      `SELECT user_id FROM user_documents WHERE document_id = ? AND access_role = 'owner'`,
      [docId]
    );
    
    // Get shared with users
    const sharedRows = query.all(
      `SELECT ds.target_user_id, ds.owner_user_id, u.email
       FROM document_shares ds
       JOIN users u ON u.id = ds.target_user_id
       WHERE ds.document_id = ?`,
      [docId]
    );
    
    // Get who shared it (for non-owners)
    const sharedByRow = query.get(
      `SELECT ds.owner_user_id, u.email
       FROM document_shares ds
       JOIN users u ON u.id = ds.owner_user_id
       WHERE ds.document_id = ?
       LIMIT 1`,
      [docId]
    );
    
    return {
      ownerId: ownerRow ? ownerRow.user_id : null,
      sharedWith: sharedRows.map(row => ({
        userId: row.target_user_id,
        email: row.email
      })),
      sharedBy: sharedByRow ? {
        userId: sharedByRow.owner_user_id,
        email: sharedByRow.email
      } : null
    };
  }

  function getDocumentAccessRole(userId, relPath) {
    const docsMap = ensureDocuments([relPath]);
    const docId = docsMap.get(relPath);
    if (!docId) return null;
    
    const row = query.get(
      `SELECT access_role FROM user_documents WHERE user_id = ? AND document_id = ?`,
      [userId, docId]
    );
    
    return row ? row.access_role : null;
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
    removeDocumentsFromUser,
    assignDocumentsToUser,
    ensureInitialMigration,
    scanSheetsDir, // exposed for reuse if needed
    shareDocument,
    unshareDocument,
    removeSelfFromSharedDocument,
    getDocumentShareInfo,
    getDocumentAccessRole,
  };
}

module.exports = {
  createDataStore,
};
