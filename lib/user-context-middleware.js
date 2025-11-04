// lib/user-context-middleware.js
// Middleware zur Verwaltung von User-Kontext (Config, Playlists, Documents) pro Request

const { AsyncLocalStorage } = require("async_hooks");

const requestState = new AsyncLocalStorage();

// User-spezifische Caches
const userConfigCache = new Map();
const userPlaylistCache = new Map();
const userDocumentCache = new Map();

/**
 * Erstellt eine Middleware, die für jeden authentifizierten Request einen User-Kontext lädt
 * und am Ende automatisch speichert, wenn Änderungen vorgenommen wurden.
 */
function createUserContextMiddleware({ dataStore, logger = console }) {
  if (!dataStore) {
    throw new Error("dataStore is required for user context middleware");
  }

  /**
   * Lädt User-Config aus Cache oder Datenbank
   */
  async function ensureUserConfig(userId) {
    let entry = userConfigCache.get(userId);
    if (entry) return entry;
    
    const config = await dataStore.getUserConfig(userId);
    entry = { config, dirty: false };
    userConfigCache.set(userId, entry);
    return entry;
  }

  /**
   * Lädt User-Playlists aus Cache oder Datenbank
   */
  async function ensureUserPlaylists(userId) {
    let entry = userPlaylistCache.get(userId);
    if (entry) return entry;
    
    const state = await dataStore.getUserPlaylists(userId);
    entry = { state, dirty: false };
    userPlaylistCache.set(userId, entry);
    return entry;
  }

  /**
   * Lädt User-Dokumente aus Cache oder Datenbank
   */
  async function ensureUserDocuments(userId) {
    let set = userDocumentCache.get(userId);
    if (set) return set;
    
    const relPaths = await dataStore.listUserDocumentRelPaths(userId);
    set = new Set(Array.isArray(relPaths) ? relPaths : []);
    userDocumentCache.set(userId, set);
    return set;
  }

  /**
   * Middleware-Funktion für Express
   */
  async function middleware(req, res, next) {
    // Nur für authentifizierte Requests
    if (!req.auth || !req.auth.user) {
      return next();
    }

    const userId = req.auth.user.id;
    
    try {
      // Lade User-Kontext
      const configEntry = await ensureUserConfig(userId);
      const playlistEntry = await ensureUserPlaylists(userId);
      const documents = await ensureUserDocuments(userId);

      // Erstelle Store für diesen Request
      const store = {
        userId,
        configEntry,
        playlistEntry,
        documents,
      };

      // Cleanup-Handler registrieren
      const originalEnd = res.end;
      const originalJson = res.json;
      let finished = false;

      async function cleanup() {
        if (finished) return;
        finished = true;

        try {
          // Speichere Config wenn dirty
          if (configEntry.dirty) {
            await dataStore.saveUserConfig(userId, configEntry.config);
            configEntry.dirty = false;
          }

          // Speichere Playlists wenn dirty
          if (playlistEntry.dirty) {
            await dataStore.saveUserPlaylists(userId, playlistEntry.state);
            playlistEntry.dirty = false;
          }
        } catch (err) {
          logger.error?.("Failed to persist user context on cleanup:", err);
        }
      }

      // Überschreibe res.end und res.json für automatisches Cleanup
      res.end = function(...args) {
        cleanup().finally(() => {
          originalEnd.apply(res, args);
        });
      };

      res.json = function(data) {
        cleanup().finally(() => {
          originalJson.call(res, data);
        });
      };

      // Cleanup auch bei Fehlern
      res.on("close", cleanup);
      res.on("finish", cleanup);

      // Führe Request mit Store-Kontext aus
      return requestState.run(store, next);
    } catch (err) {
      logger.error?.("Failed to initialize user context:", err);
      return res.status(500).json({ error: "Failed to initialize user context" });
    }
  }

  /**
   * Gibt den aktuellen Request-Kontext zurück
   */
  function getRequestContext() {
    return requestState.getStore() || null;
  }

  /**
   * Gibt den Request-Kontext zurück oder wirft einen Fehler
   */
  function requireUserContext() {
    const store = getRequestContext();
    if (!store || !store.configEntry || !store.playlistEntry) {
      throw new Error("User context not initialized for this request");
    }
    return store;
  }

  /**
   * Markiert Config als geändert
   */
  function markConfigDirty() {
    const store = getRequestContext();
    if (store?.configEntry) {
      store.configEntry.dirty = true;
    }
  }

  /**
   * Markiert Playlists als geändert
   */
  function markPlaylistsDirty() {
    const store = getRequestContext();
    if (store?.playlistEntry) {
      store.playlistEntry.dirty = true;
      store.playlistEntry.state.updatedAt = Date.now();
    }
  }

  /**
   * Speichert Config sofort (falls dirty)
   */
  async function saveConfigImmediate() {
    const store = getRequestContext();
    if (!store || !store.configEntry || !store.configEntry.dirty) return;
    
    await dataStore.saveUserConfig(store.userId, store.configEntry.config);
    store.configEntry.dirty = false;
  }

  /**
   * Speichert Playlists sofort (falls dirty)
   */
  async function savePlaylistsImmediate() {
    const store = getRequestContext();
    if (!store || !store.playlistEntry || !store.playlistEntry.dirty) return;
    
    await dataStore.saveUserPlaylists(store.userId, store.playlistEntry.state);
    store.playlistEntry.dirty = false;
  }

  /**
   * Markiert Config als dirty und speichert sofort
   */
  async function persistConfigNow() {
    markConfigDirty();
    await saveConfigImmediate();
  }

  /**
   * Fügt Dokumente zum User-Cache hinzu
   */
  function addDocumentsToUserCache(userId, relPaths) {
    if (!Array.isArray(relPaths) || !relPaths.length) return;
    const set = userDocumentCache.get(userId);
    if (!set) return;
    relPaths.forEach((rel) => {
      if (typeof rel === "string" && rel) set.add(rel);
    });
  }

  /**
   * Erstellt Proxy-Objekte für einfachen Config/Playlist-Zugriff
   */
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

  /**
   * Proxy für User-Dokumente (readonly Set)
   */
  const USER_DOCUMENTS = new Proxy({}, {
    get(_target, prop) {
      const store = requireUserContext();
      // Support Set methods
      if (prop === 'has') {
        return (value) => store.documents.has(value);
      }
      if (prop === 'size') {
        return store.documents.size;
      }
      if (prop === 'values' || prop === Symbol.iterator) {
        return () => store.documents.values();
      }
      if (prop === 'forEach') {
        return (callback, thisArg) => store.documents.forEach(callback, thisArg);
      }
      return store.documents[prop];
    }
  });

  /**
   * Flusht alle User-Caches beim Shutdown
   */
  async function flushAllUserCaches() {
    const promises = [];

    for (const [userId, entry] of userConfigCache.entries()) {
      if (entry?.dirty) {
        promises.push(
          dataStore.saveUserConfig(userId, entry.config)
            .then(() => { entry.dirty = false; })
            .catch((err) => {
              logger.error?.(`Failed to flush config for ${userId}:`, err);
            })
        );
      }
    }

    for (const [userId, entry] of userPlaylistCache.entries()) {
      if (entry?.dirty) {
        promises.push(
          dataStore.saveUserPlaylists(userId, entry.state)
            .then(() => { entry.dirty = false; })
            .catch((err) => {
              logger.error?.(`Failed to flush playlists for ${userId}:`, err);
            })
        );
      }
    }

    await Promise.all(promises);
  }

  return {
    middleware,
    getRequestContext,
    requireUserContext,
    markConfigDirty,
    markPlaylistsDirty,
    saveConfigImmediate,
    savePlaylistsImmediate,
    persistConfigNow,
    addDocumentsToUserCache,
    ensureUserDocuments,
    flushAllUserCaches,
    CONFIG,
    PLAYLIST_STATE,
    USER_DOCUMENTS,
    // Expose caches for testing/debugging
    _caches: {
      userConfigCache,
      userPlaylistCache,
      userDocumentCache,
    },
  };
}

module.exports = {
  createUserContextMiddleware,
};
