// Service Worker für Piano Sheets PWA
// Version für Cache-Invalidierung - UPDATED: Layout fix for library pager
const CACHE_VERSION = 'v10-layout-fix';
const STATIC_CACHE = `piano-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `piano-dynamic-${CACHE_VERSION}`;
const PDF_CACHE = `piano-pdfs-${CACHE_VERSION}`;
const THUMBNAIL_CACHE = `piano-thumbnails-${CACHE_VERSION}`;
const API_CACHE = `piano-api-${CACHE_VERSION}`;

// Statische Ressourcen, die sofort gecacht werden
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/base-path.js',
  '/csrf-protection.js',
  '/annotation-tools.js',
  '/jump-markers.js',
  '/auth-status.js',
  '/pdf.js',
  '/scroll-with-markers.js',
  '/manifest.json',
  '/icon-maskable.svg'
];

// Vendor-Bibliotheken (optional cachen)
const VENDOR_ASSETS = [
  '/vendor/pdfjs/pdf.min.js',
  '/vendor/pdfjs/pdf.worker.min.js',
  '/vendor/fuse.min.js',
  '/vendor/nosleep.min.js'
];

const KNOWN_CACHES = [STATIC_CACHE, DYNAMIC_CACHE, PDF_CACHE, THUMBNAIL_CACHE, API_CACHE];
const OFFLINE_ONLY_CACHES = [DYNAMIC_CACHE, PDF_CACHE, THUMBNAIL_CACHE, API_CACHE];

function resolveUrl(input) {
  try {
    return new URL(input, self.location.origin).toString();
  } catch (error) {
    console.warn('[SW] Failed to resolve URL:', input, error);
    return input;
  }
}

// Installation: Statische Assets vorab cachen
self.addEventListener('install', (event) => {
  console.log('[SW] Installing Service Worker...');
  
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        console.log('[SW] Caching static assets');
        const precacheAssets = [...new Set([...STATIC_ASSETS, ...VENDOR_ASSETS])];
        return cache.addAll(precacheAssets)
          .catch((err) => {
            // Fallback: Versuche einzeln zu cachen wenn batch fehlschlägt
            console.warn('[SW] Batch cache failed, trying individual caching', err);
            return Promise.all(
              precacheAssets.map((url) =>
                cache.add(url).catch((e) => console.warn('[SW] Failed to cache ' + url + ':', e))
              )
            );
          });
      })
      .then(() => {
        console.log('[SW] Static assets cached successfully');
        return self.skipWaiting(); // Aktiviere sofort
      })
      .catch((err) => {
        console.error('[SW] Installation failed:', err);
      })
  );
});

// Aktivierung: Alte Caches löschen
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating Service Worker...');
  
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((cacheName) => {
              // Lösche alte Versionen ODER den PDF-Cache (wegen Korruption)
              return (cacheName.startsWith('piano-') && !cacheName.endsWith(`-${CACHE_VERSION}`))
                || cacheName === PDF_CACHE; // PDF-Cache immer löschen
            })
            .map((cacheName) => {
              console.log('[SW] Deleting cache:', cacheName);
              return caches.delete(cacheName);
            })
        );
      })
      .then(async () => {
        if (self.registration.navigationPreload) {
          try {
            await self.registration.navigationPreload.enable();
            console.log('[SW] Navigation preload enabled');
          } catch (err) {
            console.warn('[SW] Navigation preload enable failed:', err);
          }
        }
        console.log('[SW] Service Worker activated (PDF cache cleared)');
        return self.clients.claim(); // Übernehme Kontrolle über alle Clients
      })
  );
});

// Fetch: Intelligente Caching-Strategie
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // WICHTIG: Ignoriere externe Domains (CDN, etc.)
  // Aber erlaube explizit music.familieklement.com und cloud.familieklement.com
  const allowedOrigins = [
    self.location.origin,
    'https://music.familieklement.com',
    'https://cloud.familieklement.com'
  ];
  
  if (!allowedOrigins.includes(url.origin)) {
    // Lass externe Requests direkt durch (keine Caching-Logik)
    console.log('[SW] Ignoring external origin:', url.origin);
    return;
  }

  if (request.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(handleNavigationRequest(event));
    return;
  }

  // Ignoriere nicht-GET Requests
  if (request.method !== 'GET') {
    return;
  }

  // Ignoriere Chrome Extension Requests
  if (url.protocol === 'chrome-extension:') {
    return;
  }

  // Ignoriere Worker-Requests (PDF.js Worker, etc.)
  // Workers müssen direkt vom Browser geladen werden
  if (request.destination === 'worker' || request.destination === 'sharedworker') {
    console.log('[SW] Bypassing worker request:', url.pathname);
    return;
  }

  // API Requests: Network-First mit Fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleAPIRequest(request));
    return;
  }

  // PDF Files: Cache-First mit Network-Fallback
  if (url.pathname.startsWith('/sheets/') && url.pathname.endsWith('.pdf')) {
    event.respondWith(handlePDFRequest(request));
    return;
  }

  // Thumbnails: Cache-First mit Network-Fallback
  if (url.pathname.startsWith('/thumbnails/')) {
    event.respondWith(handleThumbnailRequest(request));
    return;
  }

  // Vendor Files: Cache-First
  if (url.pathname.startsWith('/vendor/')) {
    event.respondWith(handleVendorRequest(request));
    return;
  }

  // Static Assets: Cache-First mit Network-Fallback
  event.respondWith(handleStaticRequest(request));
});

// Cache-First für statische Assets
async function handleStaticRequest(request) {
  try {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }

    const response = await fetch(request, {
      signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
    });
    if (response && response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    console.log('[SW] Static request failed (offline):', request.url);
    const cached = await caches.match(request);
    if (cached) {
      console.log('[SW] Serving from cache:', request.url);
      return cached;
    }
    // Fallback für HTML: Offline-Seite
    if (request.destination === 'document') {
      console.warn('[SW] No cached document, serving offline page');
      return new Response(getOfflinePage(), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    // Für andere Ressourcen: gib einen leeren Response zurück statt zu werfen
    console.warn('[SW] Resource not cached and offline:', request.url);
    return new Response('', { 
      status: 503, 
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

async function handleNavigationRequest(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) {
      return preloaded;
    }
  } catch (err) {
    console.warn('[SW] Navigation preload failed:', err);
  }

  try {
    const networkResponse = await fetch(event.request, { 
      signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined 
    });
    if (networkResponse && networkResponse.ok) {
      try {
        const cache = await caches.open(STATIC_CACHE);
        await cache.put('/index.html', networkResponse.clone());
      } catch (cacheErr) {
        console.warn('[SW] Failed to refresh cached index:', cacheErr);
      }
    }
    return networkResponse;
  } catch (error) {
    console.log('[SW] Navigation request failed (offline), serving cached shell:', error.message);
    const cachedShell = await caches.match('/index.html');
    if (cachedShell) {
      console.log('[SW] Serving cached index.html for offline navigation');
      return cachedShell;
    }
    console.warn('[SW] No cached shell available, serving offline page');
    return new Response(getOfflinePage(), {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
}

// Cache-First für Vendor-Dateien (unveränderlich)
async function handleVendorRequest(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    console.warn('[SW] Vendor request failed:', error);
    throw error;
  }
}

// Network-First für PDFs - Cache führt zu Problemen mit großen PDFs
async function handlePDFRequest(request) {
  try {
    console.log('[SW] Fetching PDF from network:', request.url);
    const response = await fetch(request);
    
    if (response && response.ok) {
      // PDFs NICHT cachen - sie sind zu groß und führen zu Cache-Korruption
      // Der Browser cached sie bereits über HTTP-Cache
      console.log('[SW] PDF fetched successfully (not caching):', request.url);
    }
    
    return response;
  } catch (error) {
    console.warn('[SW] PDF network request failed, trying cache:', error);
    
    // Nur bei Netzwerkfehler versuchen wir den Cache
    const cached = await caches.match(request, { ignoreSearch: false });
    if (cached) {
      console.log('[SW] Serving PDF from cache (fallback):', request.url);
      return cached;
    }
    
    // Wenn offline und nicht gecacht: Fehler
    return new Response('PDF nicht verfügbar (offline)', {
      status: 503,
      statusText: 'Service Unavailable'
    });
  }
}

// Cache-First für Thumbnails
async function handleThumbnailRequest(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(THUMBNAIL_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    console.warn('[SW] Thumbnail request failed:', error);
    // Fallback: Leeres Thumbnail-Bild
    return new Response(getPlaceholderThumbnail(), {
      headers: { 'Content-Type': 'image/svg+xml' }
    });
  }
}

// Network-First für API Requests mit Cache-Fallback
async function handleAPIRequest(request) {
  try {
    const response = await fetch(request);
    
    // Nur erfolgreiche Responses cachen
    if (response && response.ok) {
      const cache = await caches.open(API_CACHE);
      await cache.put(request, response.clone());
    }
    
    return response;
  } catch (error) {
    console.warn('[SW] API request failed, trying cache:', error);
    
    const cached = await caches.match(request);
    if (cached) {
      // Markiere Response als gecacht
      const cachedClone = cached.clone();
      const newHeaders = new Headers(cachedClone.headers);
      newHeaders.set('X-From-Cache', 'true');
      return new Response(cachedClone.body, {
        status: cachedClone.status,
        statusText: cachedClone.statusText,
        headers: newHeaders
      });
    }
    
    // Kein Cache verfügbar
    return new Response(JSON.stringify({ 
      error: 'Offline - keine gecachten Daten verfügbar' 
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Background Sync für später (wenn Nutzer Daten offline ändert)
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync:', event.tag);
  
  if (event.tag === 'sync-favorites') {
    event.waitUntil(syncFavorites());
  }
});

async function syncFavorites() {
  // Implementierung für Favoriten-Sync
  console.log('[SW] Syncing favorites...');
}

// Nachrichten von der App empfangen
self.addEventListener('message', (event) => {
  console.log('[SW] Message received:', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CACHE_PDF') {
    const { url } = event.data;
    if (url) {
      cachePDF(url).then(() => {
        event.ports[0]?.postMessage({ success: true });
      }).catch((error) => {
        event.ports[0]?.postMessage({ success: false, error: error.message });
      });
    } else {
      event.ports[0]?.postMessage({ success: false, error: 'No URL provided' });
    }
  }
  
  if (event.data && event.data.type === 'CACHE_URLS') {
    const { urls } = event.data;
    if (Array.isArray(urls)) {
      cacheMultipleURLs(urls).then(() => {
        event.ports[0]?.postMessage({ success: true });
      }).catch((error) => {
        event.ports[0]?.postMessage({ success: false, error: error.message });
      });
    } else {
      event.ports[0]?.postMessage({ success: false, error: 'No URLs provided' });
    }
  }
  
  if (event.data && event.data.type === 'REMOVE_URLS') {
    const { urls } = event.data;
    if (Array.isArray(urls)) {
      removeCachedUrls(urls).then((result) => {
        event.ports[0]?.postMessage({ success: true, result });
      }).catch((error) => {
        event.ports[0]?.postMessage({ success: false, error: error.message });
      });
    } else {
      event.ports[0]?.postMessage({ success: false, error: 'No URLs provided' });
    }
  }

  if (event.data && event.data.type === 'GET_CACHED_PDFS') {
    getCachedPDFs().then((pdfs) => {
      event.ports[0]?.postMessage({ pdfs });
    });
  }
  
  if (event.data && event.data.type === 'CLEAR_OFFLINE') {
    clearOfflineCaches().then(() => {
      event.ports[0]?.postMessage({ success: true });
    }).catch((error) => {
      event.ports[0]?.postMessage({ success: false, error: error.message });
    });
  }

  if (event.data && event.data.type === 'CLEAR_CACHE') {
    clearAllCaches().then(() => {
      event.ports[0]?.postMessage({ success: true });
    }).catch((error) => {
      event.ports[0]?.postMessage({ success: false, error: error.message });
    });
  }
});

// Hilfsfunktion: PDF gezielt cachen
async function cachePDF(url) {
  const absolute = resolveUrl(url);
  console.log('[SW] Caching PDF:', absolute);
  const cache = await caches.open(PDF_CACHE);
  const request = new Request(absolute, { credentials: 'same-origin' });
  const response = await fetch(request);
  if (response && response.ok) {
    await cache.put(request, response.clone());
    console.log('[SW] PDF cached successfully:', absolute);
  } else {
    const status = response ? response.status : 'network-error';
    throw new Error(`Failed to cache PDF: ${status}`);
  }
}

// Hilfsfunktion: Multiple URLs cachen
async function cacheMultipleURLs(urls) {
  const uniqueUrls = [...new Set(urls.map(resolveUrl))];
  console.log('[SW] Caching multiple URLs:', uniqueUrls.length);

  const results = await Promise.allSettled(
    uniqueUrls.map(async (absoluteUrl) => {
      const request = new Request(absoluteUrl, { credentials: 'same-origin' });
      let targetCache = DYNAMIC_CACHE;

      const { pathname } = new URL(absoluteUrl);

      if (absoluteUrl.includes('/sheets/') && absoluteUrl.endsWith('.pdf')) {
        targetCache = PDF_CACHE;
      } else if (absoluteUrl.includes('/thumbnails/')) {
        targetCache = THUMBNAIL_CACHE;
      } else if (absoluteUrl.includes('/api/')) {
        targetCache = API_CACHE;
      } else if (STATIC_ASSETS.includes(pathname) || VENDOR_ASSETS.includes(pathname)) {
        targetCache = STATIC_CACHE;
      }

      const response = await fetch(request);
      if (!response || !response.ok) {
        const status = response ? response.status : 'network-error';
        throw new Error(`Fetch failed (${status}) for ${absoluteUrl}`);
      }

      const cache = await caches.open(targetCache);
      await cache.put(request, response.clone());
      return { url: absoluteUrl, cache: targetCache };
    })
  );

  const successful = results.filter((entry) => entry.status === 'fulfilled').length;
  console.log(`[SW] Cached ${successful}/${uniqueUrls.length} URLs`);
  return results;
}

async function removeCachedUrls(urls) {
  const uniqueUrls = [...new Set(urls.map(resolveUrl))];
  console.log('[SW] Removing cached URLs:', uniqueUrls.length);

  const results = await Promise.allSettled(
    uniqueUrls.map(async (absoluteUrl) => {
      const targetCaches = new Set([DYNAMIC_CACHE]);
      if (absoluteUrl.includes('/sheets/') && absoluteUrl.endsWith('.pdf')) {
        targetCaches.add(PDF_CACHE);
      }
      if (absoluteUrl.includes('/thumbnails/')) {
        targetCaches.add(THUMBNAIL_CACHE);
      }
      if (absoluteUrl.includes('/api/')) {
        targetCaches.add(API_CACHE);
      }

      let removed = false;
      await Promise.all([...targetCaches].map(async (cacheName) => {
        const cache = await caches.open(cacheName);
        const deleted = await cache.delete(absoluteUrl);
        if (deleted) {
          removed = true;
        }
      }));

      return { url: absoluteUrl, removed };
    })
  );

  const removedCount = results.filter((entry) => entry.status === 'fulfilled' && entry.value.removed).length;
  console.log(`[SW] Removed ${removedCount}/${uniqueUrls.length} URLs`);
  return results;
}

// Hilfsfunktion: Liste gecachter PDFs abrufen
async function getCachedPDFs() {
  const cache = await caches.open(PDF_CACHE);
  const requests = await cache.keys();
  return requests
    .map(req => req.url)
    .filter(url => url.endsWith('.pdf'))
    .map(url => {
      const path = new URL(url).pathname;
      const rel = path.replace('/sheets/', '');
      return rel
        .split('/')
        .map((segment) => {
          try {
            return decodeURIComponent(segment);
          } catch (err) {
            console.warn('[SW] Failed to decode segment', segment, err);
            return segment;
          }
        })
        .join('/');
    });
}

async function clearOfflineCaches() {
  await Promise.all(OFFLINE_ONLY_CACHES.map((name) => caches.delete(name)));
  console.log('[SW] Offline caches cleared');
}

// Hilfsfunktion: Alle Caches löschen
async function clearAllCaches() {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter(name => name.startsWith('piano-'))
      .map(name => caches.delete(name))
  );
  console.log('[SW] All caches cleared');
}

// Offline-Fallback Seite
function getOfflinePage() {
  return `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Offline - Piano Sheets</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(145deg, #050506 0%, #0a0a0b 100%);
      color: #e5e7eb;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .container {
      max-width: 500px;
      text-align: center;
    }
    h1 {
      font-size: 3rem;
      margin-bottom: 1rem;
    }
    p {
      font-size: 1.1rem;
      color: #9ca3af;
      margin-bottom: 2rem;
    }
    button {
      background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
      color: white;
      border: none;
      padding: 0.75rem 2rem;
      border-radius: 0.5rem;
      font-size: 1rem;
      cursor: pointer;
      transition: transform 0.2s;
    }
    button:hover {
      transform: translateY(-2px);
    }
    button:active {
      transform: translateY(0);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎼</h1>
    <h2>Offline-Modus</h2>
    <p>Sie sind derzeit offline. Nur bereits heruntergeladene Stücke sind verfügbar.</p>
    <button onclick="window.location.reload()">Erneut versuchen</button>
  </div>
</body>
</html>
  `;
}

// Placeholder Thumbnail SVG
function getPlaceholderThumbnail() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800" width="600" height="800">
  <rect width="600" height="800" fill="#1a1a1a"/>
  <text x="50%" y="50%" font-family="Arial, sans-serif" font-size="48" fill="#6366f1" text-anchor="middle" dominant-baseline="middle">🎼</text>
  <text x="50%" y="60%" font-family="Arial, sans-serif" font-size="16" fill="#9ca3af" text-anchor="middle" dominant-baseline="middle">Vorschau offline</text>
</svg>
  `;
}

console.log('[SW] Service Worker loaded');
