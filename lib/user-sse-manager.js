// lib/user-sse-manager.js
// Per-User Server-Sent Events (SSE) Management

/**
 * Verwaltet SSE-Verbindungen pro User und Kanal
 */
class UserSSEManager {
  /**
   * Gibt alle aktiven Session-IDs (Response-Objekte) für einen User zurück
   */
  getSessionIdsForUser(userId) {
    const userMap = this.userChannels.get(userId);
    if (!userMap) return [];
    const sessions = [];
    for (const clients of userMap.values()) {
      for (const res of clients) {
        sessions.push(res);
      }
    }
    return sessions;
  }
  constructor({ logger = console } = {}) {
    this.logger = logger;
    // Map<userId, Map<channel, Set<Response>>>
    this.userChannels = new Map();
  }

  /**
   * Flushes the response stream immediately when supported (needed for SSE + compression).
   */
  flushResponse(res) {
    if (!res || typeof res.flush !== "function") return;
    try {
      res.flush();
    } catch (err) {
      this.logger.warn?.("Failed to flush SSE response:", err);
    }
  }

  /**
   * Registriert einen SSE-Client für einen User und Kanal
   */
  subscribe(userId, channel, res) {
    if (!userId || !channel || !res) {
      throw new Error("userId, channel, and res are required");
    }

    // User-Map erstellen falls nicht vorhanden
    if (!this.userChannels.has(userId)) {
      this.userChannels.set(userId, new Map());
    }

    const userMap = this.userChannels.get(userId);

    // Channel-Set erstellen falls nicht vorhanden
    if (!userMap.has(channel)) {
      userMap.set(channel, new Set());
    }

    const clients = userMap.get(channel);
    clients.add(res);

    // Cleanup wenn Verbindung geschlossen wird
    const cleanup = () => {
      clients.delete(res);
      
      // Cleanup leerer Sets
      if (clients.size === 0) {
        userMap.delete(channel);
      }
      
      // Cleanup leerer Maps
      if (userMap.size === 0) {
        this.userChannels.delete(userId);
      }
    };

    res.on("close", cleanup);
    res.on("finish", cleanup);

    return cleanup;
  }

  /**
   * Entfernt einen SSE-Client für einen User und Kanal
   */
  unsubscribe(userId, channel, res) {
    if (!userId || !channel || !res) return false;

    const userMap = this.userChannels.get(userId);
    if (!userMap) return false;

    const clients = userMap.get(channel);
    if (!clients) return false;

    const removed = clients.delete(res);
    
    // Cleanup leerer Sets
    if (clients.size === 0) {
      userMap.delete(channel);
    }
    
    // Cleanup leerer Maps
    if (userMap.size === 0) {
      this.userChannels.delete(userId);
    }

    return removed;
  }

  /**
   * Sendet ein Event an alle Clients eines Users auf einem spezifischen Kanal
   */
  broadcast(userId, channel, data, eventType = "message") {
    if (!userId || !channel) return 0;

    const userMap = this.userChannels.get(userId);
    if (!userMap) return 0;

    const clients = userMap.get(channel);
    if (!clients || clients.size === 0) return 0;

    const payload = typeof data === "string" ? data : JSON.stringify(data);
    const message = eventType !== "message" 
      ? `event: ${eventType}\ndata: ${payload}\n\n`
      : `data: ${payload}\n\n`;

    let sent = 0;
    for (const res of clients) {
      try {
        res.write(message);
        this.flushResponse(res);
        sent++;
      } catch (err) {
        this.logger.warn?.(`Failed to send SSE to user ${userId} on channel ${channel}:`, err);
        clients.delete(res);
      }
    }

    return sent;
  }

  /**
   * Sendet ein Event an alle Users (admin broadcast)
   */
  broadcastToAll(channel, data, eventType = "message") {
    let totalSent = 0;
    for (const userId of this.userChannels.keys()) {
      totalSent += this.broadcast(userId, channel, data, eventType);
    }
    return totalSent;
  }

  /**
   * Sendet Ping/Keep-Alive an alle Clients eines Users
   */
  ping(userId, channel) {
    const userMap = this.userChannels.get(userId);
    if (!userMap) return 0;

    const clients = userMap.get(channel);
    if (!clients || clients.size === 0) return 0;

    let sent = 0;
    for (const res of clients) {
      try {
        const pingPayload = JSON.stringify({ ts: Date.now() });
        res.write(`event: ping\ndata: ${pingPayload}\n\n`);
        this.flushResponse(res);
        sent++;
      } catch (err) {
        this.logger.warn?.(`Failed to ping user ${userId} on channel ${channel}:`, err);
        clients.delete(res);
      }
    }

    return sent;
  }

  /**
   * Schließt alle Verbindungen eines Users auf einem Kanal
   */
  closeChannel(userId, channel) {
    const userMap = this.userChannels.get(userId);
    if (!userMap) return 0;

    const clients = userMap.get(channel);
    if (!clients) return 0;

    let closed = 0;
    for (const res of clients) {
      try {
        res.end();
        closed++;
      } catch (err) {
        this.logger.warn?.(`Failed to close SSE for user ${userId} on channel ${channel}:`, err);
      }
    }

    userMap.delete(channel);
    if (userMap.size === 0) {
      this.userChannels.delete(userId);
    }

    return closed;
  }

  /**
   * Schließt alle Verbindungen eines Users
   */
  closeUser(userId) {
    const userMap = this.userChannels.get(userId);
    if (!userMap) return 0;

    let totalClosed = 0;
    for (const channel of userMap.keys()) {
      totalClosed += this.closeChannel(userId, channel);
    }

    return totalClosed;
  }

  /**
   * Schließt alle Verbindungen
   */
  closeAll() {
    let totalClosed = 0;
    for (const userId of this.userChannels.keys()) {
      totalClosed += this.closeUser(userId);
    }
    return totalClosed;
  }

  /**
   * Gibt die Anzahl der Subscriber für einen User zurück (alle Kanäle)
   */
  getSubscriberCount(userId, channel = null) {
    const userMap = this.userChannels.get(userId);
    if (!userMap) return 0;
    
    if (channel) {
      const clients = userMap.get(channel);
      return clients ? clients.size : 0;
    }
    
    // Count all channels for this user
    let total = 0;
    for (const clients of userMap.values()) {
      total += clients.size;
    }
    return total;
  }

  /**
   * Gibt Statistiken zurück
   */
  getStats() {
    const stats = {
      totalUsers: this.userChannels.size,
      channels: {},
      totalConnections: 0,
    };

    for (const [userId, userMap] of this.userChannels.entries()) {
      for (const [channel, clients] of userMap.entries()) {
        if (!stats.channels[channel]) {
          stats.channels[channel] = { users: 0, connections: 0 };
        }
        stats.channels[channel].users++;
        stats.channels[channel].connections += clients.size;
        stats.totalConnections += clients.size;
      }
    }

    return stats;
  }

  /**
   * Erstellt einen Keep-Alive Timer für einen Kanal
   */
  createKeepAliveTimer(userId, channel, intervalMs = 25000) {
    const timer = setInterval(() => {
      this.ping(userId, channel);
    }, intervalMs);

    // Cleanup-Handler zurückgeben
    return () => {
      clearInterval(timer);
    };
  }
}

/**
 * Express-Middleware zum Erstellen von SSE-Endpunkten
 */
function createSSEEndpoint({ 
  manager, 
  channel, 
  initialData,
  requireAuth = true,
  keepAlive = true,
  keepAliveInterval = 25000,
}) {
  if (!manager || !channel) {
    throw new Error("manager and channel are required");
  }

  return (req, res) => {
    // Auth-Check
    if (requireAuth && (!req.auth || !req.auth.user)) {
      return res.status(401).json({ error: "AUTH_REQUIRED" });
    }

    const userId = req.auth?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "AUTH_REQUIRED" });
    }

    // SSE Headers setzen
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // nginx buffering deaktivieren
    
    if (res.flushHeaders) {
      res.flushHeaders();
    }

    // Initiale Daten senden
    if (initialData) {
      try {
        const data = typeof initialData === "function" 
          ? initialData(req, res) 
          : initialData;
        
        const payload = typeof data === "string" ? data : JSON.stringify(data);
        res.write(`data: ${payload}\n\n`);
      } catch (err) {
        console.error("Failed to send initial SSE data:", err);
      }
    }

    // Client registrieren
    const unsubscribe = manager.subscribe(userId, channel, res);

    // Keep-Alive Timer starten
    let stopKeepAlive = null;
    if (keepAlive) {
      stopKeepAlive = manager.createKeepAliveTimer(userId, channel, keepAliveInterval);
    }

    // Cleanup bei Verbindungsabbruch
    req.on("close", () => {
      if (stopKeepAlive) stopKeepAlive();
      unsubscribe();
      try { res.end(); } catch {}
    });
  };
}

module.exports = {
  UserSSEManager,
  createSSEEndpoint,
};
