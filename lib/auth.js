const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SQLJS_DIR = path.join(__dirname, "..", "vendor", "sqljs");
const PASSWORD_VERSION = 1;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

async function createAuthService({ dataDir, logger = console }) {
  if (!dataDir) {
    throw new Error("dataDir is required for auth service");
  }

  await fs.promises.mkdir(dataDir, { recursive: true });

  const keyPath = path.join(dataDir, "auth-key.txt");
  const dbPath = path.join(dataDir, "auth.sqlite");

  const encryptionKey = await loadOrCreateKey(keyPath);
  const sql = await loadSqlJs();

  const db = await loadDatabase(sql, dbPath);
  ensureSchema(db);
  persist(db, dbPath);

  const helpers = buildHelpers(db, dbPath);

  await purgeExpiredSessions(helpers);
  const adminBootstrap = await ensureInitialAdmin(helpers, encryptionKey, logger);

  return buildService({
    dbHelpers: helpers,
    encryptionKey,
    adminBootstrap,
    logger,
    dbPath,
  });
}

async function loadOrCreateKey(keyPath) {
  if (process.env.AUTH_ENCRYPTION_KEY) {
    const key = decodeKey(process.env.AUTH_ENCRYPTION_KEY.trim());
    if (key.length !== 32) {
      throw new Error("AUTH_ENCRYPTION_KEY must decode to 32 bytes");
    }
    return key;
  }

  try {
    const existing = await fs.promises.readFile(keyPath, "utf8");
    const decoded = decodeKey(existing.trim());
    if (decoded.length !== 32) {
      throw new Error("Invalid auth key length");
    }
    return decoded;
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }

  const key = crypto.randomBytes(32);
  await fs.promises.writeFile(keyPath, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
  return key;
}

function decodeKey(raw) {
  if (!raw) return Buffer.alloc(0);
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  return Buffer.from(trimmed, "base64");
}

async function loadSqlJs() {
  const initSqlJs = require("../vendor/sqljs/sql-wasm.js");
  return await initSqlJs({
    locateFile: (file) => path.join(SQLJS_DIR, file),
  });
}

async function loadDatabase(sql, dbPath) {
  try {
    const raw = await fs.promises.readFile(dbPath);
    return new sql.Database(raw);
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
    return new sql.Database();
  }
}

function ensureSchema(db) {
  db.run(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_encrypted TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      is_active INTEGER NOT NULL DEFAULT 1,
      pdf_count INTEGER NOT NULL DEFAULT 0,
      storage_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS migrations (
      key TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      payload TEXT
    );

    CREATE TABLE IF NOT EXISTS user_configs (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_playlists (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      rel_path TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_documents (
      user_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      access_role TEXT NOT NULL CHECK (access_role IN ('owner', 'shared')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, document_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS document_shares (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      permissions TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(document_id, owner_user_id, target_user_id),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS page_views (
      id TEXT PRIMARY KEY,
      page_type TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_documents_rel_path ON documents(rel_path);
    CREATE INDEX IF NOT EXISTS idx_user_documents_document ON user_documents(document_id);
    CREATE INDEX IF NOT EXISTS idx_user_documents_user ON user_documents(user_id);
    CREATE INDEX IF NOT EXISTS idx_document_shares_document ON document_shares(document_id);
    CREATE INDEX IF NOT EXISTS idx_document_shares_target ON document_shares(target_user_id);
    CREATE INDEX IF NOT EXISTS idx_page_views_page_type ON page_views(page_type);
    CREATE INDEX IF NOT EXISTS idx_page_views_timestamp ON page_views(timestamp);
  `);
}

function persist(db, dbPath) {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

function buildHelpers(db, dbPath) {
  function run(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      while (stmt.step()) {
        // exhaust execution
      }
      return db.getRowsModified();
    } finally {
      stmt.free();
    }
  }

  function get(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    const results = [];
    try {
      stmt.bind(params);
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
    } finally {
      stmt.free();
    }
    return results;
  }

  function transactional(callback) {
    db.run("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = callback({ run, get, all });
      db.run("COMMIT");
      persist(db, dbPath);
      return result;
    } catch (err) {
      try { db.run("ROLLBACK"); } catch {}
      throw err;
    }
  }

  function saveIfDirty(modified) {
    if (modified) {
      persist(db, dbPath);
    }
    return modified;
  }

  return {
    run,
    get,
    all,
    transactional,
    saveIfDirty,
    db,
    dbPath,
  };
}

async function purgeExpiredSessions({ run, saveIfDirty }) {
  const nowIso = new Date().toISOString();
  const modified = run("DELETE FROM sessions WHERE expires_at <= ?", [nowIso]);
  saveIfDirty(modified);
}

async function ensureInitialAdmin(helpers, encryptionKey, logger) {
  const { get, transactional } = helpers;
  const existing = get(
    "SELECT id, email FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1"
  );
  if (existing) return null;

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase() || "admin@example.com";
  const password = process.env.ADMIN_PASSWORD?.trim() || "ChangeMe123!";
  const displayPassword = process.env.ADMIN_PASSWORD ? null : password;

  const encrypted = encryptPassword(password, encryptionKey);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  transactional(({ run }) => {
    run(
      `INSERT INTO users (id, email, password_encrypted, role, is_active, pdf_count, storage_bytes, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', 1, 0, 0, ?, ?)`,
      [id, email, encrypted, now, now]
    );
  });

  if (displayPassword) {
    logger.warn(
      `Initial admin user created with default credentials: ${email} / ${displayPassword}. Please change immediately.`
    );
    return { email, password: displayPassword };
  }

  logger.info(`Initial admin user created: ${email}`);
  return { email, password: null };
}

function buildService({ dbHelpers, encryptionKey, logger, dbPath, adminBootstrap }) {
  const { run, get, all, transactional, saveIfDirty } = dbHelpers;

  function normalizeEmail(email) {
    if (!email || typeof email !== "string") return "";
    return email.trim().toLowerCase();
  }

  function mapUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      isActive: Boolean(row.is_active),
      pdfCount: Number(row.pdf_count || 0),
      storageBytes: Number(row.storage_bytes || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function mapSession(row) {
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  function createUser({ email, password, role = "user", isActive = true, pdfCount = 0, storageBytes = 0 }) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      const err = new Error("E_EMAIL_REQUIRED");
      err.code = "E_EMAIL_REQUIRED";
      throw err;
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      const err = new Error("E_PASSWORD_WEAK");
      err.code = "E_PASSWORD_WEAK";
      throw err;
    }
    if (role !== "admin" && role !== "user") {
      const err = new Error("E_ROLE_INVALID");
      err.code = "E_ROLE_INVALID";
      throw err;
    }

    const now = new Date().toISOString();
    const encrypted = encryptPassword(password, encryptionKey);
    const id = crypto.randomUUID();

    let modified;
    try {
      modified = transactional(({ run: txRun }) => {
        const inserted = txRun(
          `INSERT INTO users (id, email, password_encrypted, role, is_active, pdf_count, storage_bytes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            normalizedEmail,
            encrypted,
            role,
            isActive ? 1 : 0,
            Number(pdfCount) || 0,
            Number(storageBytes) || 0,
            now,
            now,
          ]
        );
        return inserted;
      });
    } catch (err) {
      if (err.message && err.message.includes("UNIQUE constraint failed: users.email")) {
        const dup = new Error("E_EMAIL_EXISTS");
        dup.code = "E_EMAIL_EXISTS";
        throw dup;
      }
      throw err;
    }

    if (modified) {
      logger.info(`Created user ${normalizedEmail} (${role})`);
    }

    return getUserById(id);
  }

  function getUserByEmail(email) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;
    const row = get(
      `SELECT id, email, role, is_active, pdf_count, storage_bytes, created_at, updated_at, password_encrypted
       FROM users WHERE email = ?`,
      [normalizedEmail]
    );
    return row ? { ...mapUser(row), passwordEncrypted: row.password_encrypted } : null;
  }

  function getUserById(id) {
    const row = get(
      `SELECT id, email, role, is_active, pdf_count, storage_bytes, created_at, updated_at
       FROM users WHERE id = ?`,
      [id]
    );
    return mapUser(row);
  }

  function listUsers() {
    const rows = all(
      `SELECT id, email, role, is_active, pdf_count, storage_bytes, created_at, updated_at
       FROM users ORDER BY created_at ASC`
    );
    return rows.map(mapUser);
  }

  function setUserStatus(id, { isActive, role }) {
    const updates = [];
    const params = [];
    if (typeof isActive === "boolean") {
      updates.push("is_active = ?");
      params.push(isActive ? 1 : 0);
    }
    if (role === "admin" || role === "user") {
      updates.push("role = ?");
      params.push(role);
    }
    if (!updates.length) return 0;

    const now = new Date().toISOString();
    updates.push("updated_at = ?");
    params.push(now);
    params.push(id);

    const modified = run(
      `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
      params
    );
    saveIfDirty(modified);
    return modified;
  }

  function updateUserUsage(id, { pdfCount, storageBytes }) {
    const updates = [];
    const params = [];
    if (Number.isFinite(pdfCount)) {
      updates.push("pdf_count = ?");
      params.push(Math.max(0, Math.floor(pdfCount)));
    }
    if (Number.isFinite(storageBytes)) {
      updates.push("storage_bytes = ?");
      params.push(Math.max(0, Math.floor(storageBytes)));
    }
    if (!updates.length) return 0;
    const now = new Date().toISOString();
    updates.push("updated_at = ?");
    params.push(now);
    params.push(id);
    const modified = run(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, params);
    saveIfDirty(modified);
    return modified;
  }

  function deleteUser(id) {
    const modified = transactional(({ run: txRun }) => {
      txRun("DELETE FROM sessions WHERE user_id = ?", [id]);
      return txRun("DELETE FROM users WHERE id = ?", [id]);
    });
    if (modified) {
      logger.info(`Deleted user ${id}`);
    }
    return modified;
  }

  function resetPassword(id, newPassword) {
    if (!newPassword || typeof newPassword !== "string" || newPassword.length < 6) {
      const err = new Error("E_PASSWORD_WEAK");
      err.code = "E_PASSWORD_WEAK";
      throw err;
    }
    const encrypted = encryptPassword(newPassword, encryptionKey);
    const now = new Date().toISOString();
    const modified = run(
      `UPDATE users SET password_encrypted = ?, updated_at = ? WHERE id = ?`,
      [encrypted, now, id]
    );
    saveIfDirty(modified);
    return modified;
  }

  function createSession(userId, ttlMs = SESSION_TTL_MS) {
    const sessionId = crypto.randomUUID();
    const now = new Date();
    const expires = new Date(now.getTime() + ttlMs);
    const createdAt = now.toISOString();
    const expiresAt = expires.toISOString();

    const modified = transactional(({ run: txRun }) => {
      return txRun(
        `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
        [sessionId, userId, createdAt, expiresAt]
      );
    });

    return modified ? { id: sessionId, userId, createdAt, expiresAt } : null;
  }

  function getSessionWithUser(sessionId) {
    const row = get(
      `SELECT s.id AS session_id, s.user_id, s.created_at, s.expires_at,
              u.email, u.role, u.is_active, u.pdf_count, u.storage_bytes, u.created_at AS user_created_at, u.updated_at AS user_updated_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
      [sessionId]
    );
    if (!row) return null;
    const session = {
      id: row.session_id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
    const user = {
      id: row.user_id,
      email: row.email,
      role: row.role,
      isActive: Boolean(row.is_active),
      pdfCount: Number(row.pdf_count || 0),
      storageBytes: Number(row.storage_bytes || 0),
      createdAt: row.user_created_at,
      updatedAt: row.user_updated_at,
    };
    return { session, user };
  }

  function touchSession(sessionId, ttlMs = SESSION_TTL_MS) {
    const now = new Date();
    const expires = new Date(now.getTime() + ttlMs);
    const expiresAt = expires.toISOString();
    const modified = run(
      `UPDATE sessions SET expires_at = ? WHERE id = ?`,
      [expiresAt, sessionId]
    );
    saveIfDirty(modified);
    return modified ? expiresAt : null;
  }

  function deleteSession(sessionId) {
    const modified = run("DELETE FROM sessions WHERE id = ?", [sessionId]);
    saveIfDirty(modified);
    return modified;
  }

  function deleteSessionsByUser(userId) {
    const modified = run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    saveIfDirty(modified);
    return modified;
  }

  function verifyPassword(password, encryptedRecord) {
    try {
      return verifyEncryptedPassword(password, encryptedRecord, encryptionKey);
    } catch {
      return false;
    }
  }

  function toPublicUser(user) {
    if (!user) return null;
    const { passwordEncrypted, ...rest } = user;
    return rest;
  }

  return {
    dbPath,
    listUsers,
    createUser,
    getUserByEmail,
    getUserById,
    setUserStatus,
    updateUserUsage,
    deleteUser,
    resetPassword,
    createSession,
    getSessionWithUser,
    touchSession,
    deleteSession,
    deleteSessionsByUser,
    verifyPassword,
    toPublicUser,
    transactional,
    encryptionKey,
    adminBootstrap,
    query: {
      run,
      get,
      all,
    },
  };
}

function encryptPassword(password, key) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hashBuffer = crypto.scryptSync(password, salt, 64);
  const hashHex = hashBuffer.toString("hex");
  const payload = JSON.stringify({
    v: PASSWORD_VERSION,
    alg: "scrypt",
    salt,
    hash: hashHex,
    len: 64,
  });
  return encrypt(payload, key);
}

function verifyEncryptedPassword(password, encryptedRecord, key) {
  if (!encryptedRecord) return false;
  const payload = decrypt(encryptedRecord, key);
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return false;
  }
  if (!parsed || parsed.v !== PASSWORD_VERSION) return false;
  if (!parsed.salt || !parsed.hash) return false;

  const derived = crypto.scryptSync(password, parsed.salt, parsed.len || 64);
  const derivedHex = derived.toString("hex");
  const expected = Buffer.from(parsed.hash, "hex");
  const actual = Buffer.from(derivedHex, "hex");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(encoded, key) {
  const data = Buffer.from(encoded, "base64");
  if (data.length < 28) throw new Error("Invalid ciphertext");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString("utf8");
}

module.exports = {
  createAuthService,
  encryptPassword,
  verifyEncryptedPassword,
};
