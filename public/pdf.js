// ----- PDF.js Worker setzen -----
window.addEventListener("load", () => {
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.js";
  }
});

const $ = (sel, el = document) => el.querySelector(sel);
const appEl = $("#app");
const controlsEl = $("#controls");
const headerActionsEl = $("#header-actions");

const params = new URLSearchParams(location.search);
const currentFile = params.get("file"); // encoded

// ---- Global State ----
const state = {
  library: {
    total: 0,
    sort: localStorage.getItem("libSort") || "name",
    order: localStorage.getItem("libOrder") || "asc",
    q: "",
    view: localStorage.getItem("libView") || "grid",
    favorites: new Set(), // vom Backend geladen
    pageSize: 120,
    page: 1,
    items: []
  },
  viewer: {
    fileName: null, url: null, numPages: 0,
    secsPerPage: 45,
    autoScroll: { running: false, lastTs: 0, speedPxPerSec: 0 },
    wakeLock: null
  },
  thumbs: { cache: new Map(), queue: [], running: 0, maxConcurrent: 2 }
};

// ===== Router =====
(async function init() {
  if (currentFile) {
    await renderViewer(decodeURIComponent(currentFile));
  } else {
    await loadPrefsFromBackend();
    await loadPage();
    renderLibrary();
  }
})();

// ===== Backend Prefs =====
async function loadPrefsFromBackend() {
  try {
    const res = await fetch("/api/prefs", { cache: "no-store" });
    if (!res.ok) return;
    const prefs = await res.json();
    if (Array.isArray(prefs.favorites)) {
      state.library.favorites = new Set(prefs.favorites);
    }
  } catch {}
}
async function setFavoriteOnBackend(name, favorite) {
  try {
    const res = await fetch("/api/prefs/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, favorite })
    });
    if (res.ok) {
      const j = await res.json();
      if (Array.isArray(j.favorites)) {
        state.library.favorites = new Set(j.favorites);
      }
    }
  } catch {}
}
async function getFileSecsFromBackend(name) {
  try {
    const res = await fetch(`/api/prefs/file?name=${encodeURIComponent(name)}`, { cache: "no-store" });
    if (!res.ok) return null;
    const j = await res.json();
    return Number(j.secsPerPage) || null;
  } catch { return null; }
}
async function setFileSecsOnBackend(name, secs) {
  try {
    await fetch("/api/prefs/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, secsPerPage: secs })
    });
  } catch {}
}

// ===== API (Library) =====
async function fetchPage({ q = "", sort, order, page, pageSize }) {
  const qs = new URLSearchParams({ q, sort, order, page: String(page), pageSize: String(pageSize) });
  const res = await fetch(`/api/sheets?${qs.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error("API error");
  return res.json();
}
async function loadPage() {
  const L = state.library;
  const data = await fetchPage({ q: L.q, sort: L.sort, order: L.order, page: L.page, pageSize: L.pageSize });
  L.items = data.items || [];
  L.total = data.total || 0;
}

// ===== Library UI =====
function renderLibrary() {
  controlsEl.classList.add("hidden");
  headerActionsEl.innerHTML = "";

  const L = state.library;

  appEl.innerHTML = `
    <section class="mb-4 flex flex-wrap items-center gap-2">
      <input id="search" placeholder="Suche nach Titel…"
             class="w-72 max-w-full px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800" />
      <select id="sort" class="px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800">
        <option value="name">Name</option>
        <option value="mtime">Zuletzt geändert</option>
        <option value="size">Dateigröße</option>
      </select>
      <select id="order" class="px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800">
        <option value="asc">↑ aufsteigend</option>
        <option value="desc">↓ absteigend</option>
      </select>
      <button id="toggleView" class="px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800">
        Ansicht: ${L.view === "grid" ? "Grid" : "Liste"}
      </button>
      <button id="filterFav" class="px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800">★ Favoriten</button>
      <span class="ml-auto text-sm text-neutral-400">${L.total} Dateien</span>
    </section>

    <section id="virtualWrap" class="relative overflow-auto border border-neutral-800 rounded-xl bg-neutral-900 h-[70vh]"></section>

    <section class="mt-3 flex items-center justify-between">
      <button id="prevPage" class="px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800">« Zurück</button>
      <div class="text-sm text-neutral-400">Seite <span id="pNow">${L.page}</span></div>
      <button id="nextPage" class="px-3 py-2 rounded-lg bg-neutral-900 border border-neutral-800">Weiter »</button>
    </section>
  `;

  const searchEl = $("#search");
  const sortEl = $("#sort");
  const orderEl = $("#order");
  const viewBtn = $("#toggleView");

  searchEl.value = L.q;
  sortEl.value = L.sort;
  orderEl.value = L.order;

  let searchTimer = null;
  searchEl.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.library.q = e.target.value.trim();
      state.library.page = 1;
      await loadPage();
      mountVirtualizer(true);
      $("#pNow").textContent = state.library.page;
    }, 150);
  });

  sortEl.onchange = async (e) => {
    L.sort = e.target.value; localStorage.setItem("libSort", L.sort);
    L.page = 1; await loadPage(); mountVirtualizer(true);
    $("#pNow").textContent = L.page;
  };
  orderEl.onchange = async (e) => {
    L.order = e.target.value; localStorage.setItem("libOrder", L.order);
    L.page = 1; await loadPage(); mountVirtualizer(true);
    $("#pNow").textContent = L.page;
  };
  viewBtn.onclick = () => {
    L.view = L.view === "grid" ? "list" : "grid";
    localStorage.setItem("libView", L.view);
    mountVirtualizer(true);
    viewBtn.textContent = `Ansicht: ${L.view === "grid" ? "Grid" : "Liste"}`;
  };

  $("#filterFav").onclick = () => {
    state.library.q = "__FAV__";
    searchEl.value = "";
    mountVirtualizer(true);
  };
  $("#prevPage").onclick = async () => {
    if (state.library.page > 1) {
      state.library.page--; $("#pNow").textContent = state.library.page;
      await loadPage(); mountVirtualizer(true);
    }
  };
  $("#nextPage").onclick = async () => {
    const maxPage = Math.max(1, Math.ceil(state.library.total / state.library.pageSize));
    if (state.library.page < maxPage) {
      state.library.page++; $("#pNow").textContent = state.library.page;
      await loadPage(); mountVirtualizer(true);
    }
  };

  mountVirtualizer(true);
}

// ===== Virtualized Grid/List =====
function mountVirtualizer(resetScroll = false) {
  const wrap = $("#virtualWrap");
  wrap.innerHTML = "";

  const L = state.library;
  let items = L.items;

  if (L.q === "__FAV__") {
    items = items.filter(x => state.library.favorites.has(x.name));
  }

  const fuse = window.Fuse && L.q && L.q !== "__FAV__"
    ? new Fuse(items, { keys: ["name"], threshold: 0.3 })
    : null;
  if (fuse) items = fuse.search(L.q).map(r => r.item);

  const isGrid = L.view === "grid";
  const cardW = isGrid ? 220 : wrap.clientWidth;
  const cardH = isGrid ? 320 : 72;
  const gap = isGrid ? 12 : 0;
  let cols = isGrid ? Math.max(1, Math.floor((wrap.clientWidth - 16) / (cardW + gap))) : 1;

  const total = items.length;
  const rows = Math.ceil(total / cols);
  const totalHeight = rows * (cardH + (isGrid ? gap : 0));

  const scroller = document.createElement("div");
  scroller.className = "relative w-full h-full overflow-auto no-scrollbar";
  const spacer = document.createElement("div");
  spacer.style.height = `${totalHeight}px`;
  spacer.style.position = "relative";
  scroller.appendChild(spacer);
  wrap.appendChild(scroller);

  const pool = new Map();

  function renderViewport() {
    const scrollTop = scroller.scrollTop;
    const viewH = scroller.clientHeight;
    const bufferRows = 3;

    const firstRow = Math.max(0, Math.floor(scrollTop / (cardH + (isGrid ? gap : 0))) - bufferRows);
    const lastRow  = Math.min(rows - 1, Math.floor((scrollTop + viewH) / (cardH + (isGrid ? gap : 0))) + bufferRows);

    const firstIndex = firstRow * cols;
    const lastIndex  = Math.min(total - 1, (lastRow + 1) * cols - 1);

    for (const [key, el] of pool) {
      const idx = Number(key);
      if (idx < firstIndex || idx > lastIndex) {
        pool.delete(key); el.remove();
      }
    }

    for (let i = firstIndex; i <= lastIndex; i++) {
      if (i < 0 || i >= total) continue;
      const key = String(i);
      if (pool.has(key)) continue;

      const item = items[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = isGrid ? col * (cardW + gap) : 0;
      const y = row * (cardH + (isGrid ? gap : 0));

      const el = isGrid ? renderCard(item) : renderRow(item);
      el.style.position = "absolute";
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${isGrid ? cardW : wrap.clientWidth}px`;
      el.style.height = `${cardH}px`;

      spacer.appendChild(el);
      pool.set(key, el);

      const canvas = el.querySelector("canvas[data-url]");
      if (canvas) lazyThumb(canvas);
    }
  }

  scroller.addEventListener("scroll", renderViewport, { passive: true });
  window.addEventListener("resize", () => mountVirtualizer(false), { once: true });

  renderViewport();
  if (resetScroll) scroller.scrollTop = 0;
}

function renderCard(item) {
  const a = document.createElement("a");
  a.href = `/?file=${item.id}`;
  a.className = "card block overflow-hidden border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 rounded-xl transition will-change-transform";
  a.innerHTML = `
    <div class="w-full h-[240px] bg-neutral-950 grid place-items-center">
      <canvas data-url="${item.url}" width="200" height="260" class="thumb max-h-full max-w-full"></canvas>
    </div>
    <div class="p-3 flex items-center gap-2">
      <div class="flex-1 min-w-0">
        <div class="font-medium truncate" title="${item.name}">${item.name}</div>
        <div class="text-xs text-neutral-400">${formatSize(item.size)} • ${new Date(item.mtime).toLocaleDateString()}</div>
      </div>
      <button class="fav text-lg leading-none">${state.library.favorites.has(item.name) ? "★" : "☆"}</button>
    </div>
  `;
  a.querySelector(".fav").onclick = async (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    const makeFav = !state.library.favorites.has(item.name);
    await setFavoriteOnBackend(item.name, makeFav);
    if (makeFav) state.library.favorites.add(item.name);
    else state.library.favorites.delete(item.name);
    ev.currentTarget.textContent = makeFav ? "★" : "☆";
  };
  return a;
}
function renderRow(item) {
  const a = document.createElement("a");
  a.href = `/?file=${item.id}`;
  a.className = "flex items-center gap-3 px-3 border-b border-neutral-800 hover:bg-neutral-900";
  a.innerHTML = `
    <canvas data-url="${item.url}" width="56" height="72" class="thumb shrink-0 rounded bg-neutral-950"></canvas>
    <div class="flex-1 min-w-0">
      <div class="font-medium truncate" title="${item.name}">${item.name}</div>
      <div class="text-xs text-neutral-400">${formatSize(item.size)} • ${new Date(item.mtime).toLocaleDateString()}</div>
    </div>
    <button class="fav text-xl leading-none">${state.library.favorites.has(item.name) ? "★" : "☆"}</button>
  `;
  a.querySelector(".fav").onclick = async (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    const makeFav = !state.library.favorites.has(item.name);
    await setFavoriteOnBackend(item.name, makeFav);
    if (makeFav) state.library.favorites.add(item.name);
    else state.library.favorites.delete(item.name);
    ev.currentTarget.textContent = makeFav ? "★" : "☆";
  };
  return a;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(1)} MB`;
}

// ===== Thumbnails (lazy + concurrency limit) =====
function lazyThumb(canvas) {
  const url = canvas.dataset.url;
  if (!url) return;
  if (state.thumbs.cache.has(url)) {
    drawThumbOnCanvas(canvas, state.thumbs.cache.get(url));
    return;
  }
  enqueueThumb(async () => {
    try {
      if (!window.pdfjsLib) return;
      const pdf = await pdfjsLib.getDocument(url).promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const targetW = canvas.width;
      const scale = targetW / viewport.width;
      const vp = page.getViewport({ scale });
      const off = document.createElement("canvas");
      off.width = vp.width; off.height = vp.height;
      await page.render({ canvasContext: off.getContext("2d"), viewport: vp }).promise;
      state.thumbs.cache.set(url, off);
      drawThumbOnCanvas(canvas, off);
    } catch {}
  });
}
function drawThumbOnCanvas(dest, srcCanvas) {
  const ctx = dest.getContext("2d");
  ctx.clearRect(0, 0, dest.width, dest.height);
  const ratio = Math.min(dest.width / srcCanvas.width, dest.height / srcCanvas.height);
  const w = srcCanvas.width * ratio;
  const h = srcCanvas.height * ratio;
  const x = (dest.width - w) / 2;
  const y = (dest.height - h) / 2;
  ctx.drawImage(srcCanvas, x, y, w, h);
}
function enqueueThumb(task) {
  state.thumbs.queue.push(task);
  pumpQueue();
}
function pumpQueue() {
  const T = state.thumbs;
  while (T.running < T.maxConcurrent && T.queue.length) {
    const fn = T.queue.shift();
    T.running++;
    Promise.resolve().then(fn).finally(() => {
      T.running--; pumpQueue();
    });
  }
}

// ===== Viewer =====
async function renderViewer(fileName) {
  console.log("🎼 renderViewer called with:", fileName);
  
  // WICHTIG: Viewer-Modus aktivieren - entfernt Header, passt Layout an
  document.body.classList.add("in-viewer");
  console.log("✓ Added in-viewer class");
  
  controlsEl.classList.remove("hidden");
  console.log("✓ Controls shown (removed hidden)");
  
  headerActionsEl.innerHTML = `<a href="/" class="px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 border border-neutral-700">← Library</a>`;

  // Viewer nimmt den gesamten verfügbaren Platz ein (flex: 1)
  // Kein festes vh - flexbox regelt die Höhe automatisch
  appEl.innerHTML = `
    <div id="viewer" class="flex-1 min-h-0 no-scrollbar overflow-y-auto"></div>
  `;

  const container = $("#viewer");
  state.viewer.fileName = fileName;
  state.viewer.url = `/sheets/${encodeURIComponent(fileName)}`;

  $("#btnBack").onclick = () => {
    document.body.classList.remove("in-viewer");
    location.href = "/";
  };
  $("#btnFullscreen").onclick = toggleFullscreen;
  $("#btnWakeLock").onclick = toggleWakeLock;

  // EIN Button für Play/Pause
  const btnPlayPause = $("#btnPlayPause");
  btnPlayPause.onclick = () => {
    if (state.viewer.autoScroll.running) stopAutoScroll();
    else startAutoScroll();
    refreshPlayPauseUI();
  };

  // Sek./Seite: aus Backend holen; fallback 45
  const backendSecs = await getFileSecsFromBackend(fileName);
  state.viewer.secsPerPage = backendSecs || 45;
  const secsInput = $("#secsPerPage");
  secsInput.value = state.viewer.secsPerPage;
  secsInput.addEventListener("change", async (e) => {
    const v = Math.max(5, Math.min(600, Number(e.target.value || 45)));
    state.viewer.secsPerPage = v;
    await setFileSecsOnBackend(fileName, v);
    updateStatus();
    if (state.viewer.autoScroll.running) computeSpeed();
  });

  // Keyboard
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") { e.preventDefault(); btnPlayPause.click(); }
    if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFullscreen(); }
    if (e.key === "Escape") { if (state.viewer.autoScroll.running) { stopAutoScroll(); refreshPlayPauseUI(); } }
  });

  updateStatus("Lade…");
  await mountPdfVirtual(container, state.viewer.url);
  
  // KRITISCH: Control-Bar Positionierung basierend auf echtem Viewport
  try {
    adjustViewerPadding();
  } catch (e) {
    console.error("Error positioning control bar:", e);
  }
  
  window.addEventListener("resize", () => {
    try {
      adjustViewerPadding();
    } catch (e) {
      console.error("Error in resize handler:", e);
    }
  }, { passive: true });
  
  // Auch bei Orientierungswechsel neu berechnen (wichtig für iPad)
  window.addEventListener("orientationchange", () => {
    setTimeout(() => {
      try {
        adjustViewerPadding();
      } catch (e) {
        console.error("Error in orientation handler:", e);
      }
    }, 100); // Kurze Verzögerung damit iOS das Layout aktualisiert hat
  }, { passive: true });
  
  updateStatus();
  refreshPlayPauseUI();

  function adjustViewerPadding() {
    const viewer = document.getElementById("viewer");
    if (!viewer) {
      console.warn("Viewer element not found");
      return;
    }
    
    const controlsInner = document.getElementById("controlsInner");
    const ctrlHeight = controlsInner?.offsetHeight || 0;
    
    // Safe-Area-Bottom ermitteln (für iPhone/iPad mit Home-Indikator)
    const safeAreaBottom = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--sab') || '0',
      10
    ) || 0;
    
    // Höhe = Control-Panel-Höhe + Safe-Area + Puffer
    const padding = ctrlHeight + safeAreaBottom + 24;
    viewer.style.paddingBottom = padding + "px";
    
    console.log(`📐 Viewer padding adjusted: ${padding}px (controls: ${ctrlHeight}px, safe-area: ${safeAreaBottom}px)`);
  }
}

// Virtualized pages
async function mountPdfVirtual(container, url) {
  if (!window.pdfjsLib) {
    container.innerHTML = `<embed src="${url}" type="application/pdf" class="w-full h-full" />
      <div class="p-4 text-sm text-amber-400">Hinweis: Fallback-Viewer aktiv.</div>`;
    state.viewer.numPages = 1;
    return;
  }

  const pdf = await pdfjsLib.getDocument(url).promise;
  state.viewer.numPages = pdf.numPages;

  const wrap = document.createElement("div");
  wrap.className = "w-full flex flex-col items-center gap-1";
  wrap.dataset.viewerWrap = "1";
  wrap.style.paddingBottom = "0";
  container.innerHTML = ""; container.appendChild(wrap);

  let pageH = 1400;
  const placeholders = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const ph = document.createElement("div");
    ph.className = "w-full flex flex-col items-center";
    ph.style.height = `${pageH + 18}px`;
    ph.dataset.page = String(i);
    ph.innerHTML = `<div class="text-xs text-neutral-400 mb-1">Seite ${i} / ${pdf.numPages}</div>
                    <div class="w-[95%] max-w-[1400px] h-[${pageH}px] bg-black/60 rounded animate-pulse"></div>`;
    wrap.appendChild(ph); placeholders.push(ph);
  }

  const io = new IntersectionObserver(async (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const ph = en.target; io.unobserve(ph);
      const pageIndex = Number(ph.dataset.page);
      await renderOnePageInto(ph, pdf, pageIndex);
      if (pageIndex === 1) {
        const canvas = ph.querySelector("canvas");
        if (canvas) {
          pageH = canvas.height;
          placeholders.forEach(node => {
            if (!node.querySelector("canvas")) {
              node.style.height = `${pageH + 18}px`;
              const sh = node.querySelector("div:nth-child(2)");
              if (sh) sh.style.height = `${pageH}px`;
            }
          });
        }
      }
    }
  }, { root: container, rootMargin: "800px 0px" });

  const cleanupIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const ph = en.target;
      if (en.isIntersecting) continue;
      const canvas = ph.querySelector("canvas");
      if (!canvas) continue;
      const rect = ph.getBoundingClientRect();
      const rootRect = container.getBoundingClientRect();
      const far = (rect.bottom < rootRect.top - 2000) || (rect.top > rootRect.bottom + 2000);
      if (far) {
        canvas.remove();
        const sh = ph.querySelector("div:nth-child(2)");
        if (sh) sh.classList.add("animate-pulse");
      }
    }
  }, { root: container });

  placeholders.forEach(ph => { io.observe(ph); cleanupIO.observe(ph); });
}
async function renderOnePageInto(ph, pdf, i) {
  const page = await pdf.getPage(i);
  const container = ph.parentElement;
  
  // Original-Dimensionen der PDF-Seite
  const originalViewport = page.getViewport({ scale: 1 });
  const originalWidth = originalViewport.width;
  const originalHeight = originalViewport.height;
  
  // DEBUG: Ausgabe der Original-Dimensionen
  console.log(`Page ${i}: Original dimensions = ${originalWidth}x${originalHeight}px`);
  
  // Verfügbare Container-Breite
  const containerWidth = container.clientWidth;
  const maxDisplayWidth = Math.min(1200, containerWidth * 0.9);
  
  console.log(`Page ${i}: Container width = ${containerWidth}px, maxDisplayWidth = ${maxDisplayWidth}px`);
  
  // Intelligente Skalierung:
  // - Große PDFs (>maxDisplayWidth): auf maxDisplayWidth verkleinern
  // - Kleine PDFs (<=maxDisplayWidth): NICHT vergrößern, Original-Größe beibehalten
  let displayScale;
  if (originalWidth > maxDisplayWidth) {
    // PDF ist breiter als Ziel -> verkleinern
    displayScale = maxDisplayWidth / originalWidth;
    console.log(`Page ${i}: PDF is LARGE, scaling DOWN to ${displayScale.toFixed(2)}x`);
  } else {
    // PDF ist schmaler als Ziel -> NICHT zoomen, 1:1 anzeigen
    displayScale = 1.0;
    console.log(`Page ${i}: PDF is SMALL, keeping original size (1.0x)`);
  }
  
  // Finale Anzeige-Dimensionen
  const displayWidth = originalWidth * displayScale;
  const displayHeight = originalHeight * displayScale;
  
  console.log(`Page ${i}: Final display size = ${displayWidth}x${displayHeight}px`);
  
  // Rendering mit höherer Auflösung für Retina
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const renderScale = displayScale * dpr;
  const renderViewport = page.getViewport({ scale: renderScale });
  
  const canvas = document.createElement("canvas");
  canvas.width = renderViewport.width;
  canvas.height = renderViewport.height;
  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${displayHeight}px`;
  canvas.className = "rounded bg-black mx-auto block";
  
  const ctx = canvas.getContext("2d", { alpha: false });
  await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
  
  const sk = ph.querySelector("div:nth-child(2)");
  if (sk) sk.replaceWith(canvas);
}

// ===== Auto Scroll + UI Toggle =====
function computeSpeed() {
  const el = $("#viewer");
  const totalScrollable = Math.max(0, el.scrollHeight - el.clientHeight);
  const totalSecs = state.viewer.secsPerPage * Math.max(1, state.viewer.numPages);
  state.viewer.autoScroll.speedPxPerSec = totalSecs > 0 ? totalScrollable / totalSecs : 0;
}
function startAutoScroll() {
  if (state.viewer.autoScroll.running) return;
  computeSpeed();
  state.viewer.autoScroll.running = true;
  state.viewer.autoScroll.lastTs = performance.now();
  updateStatus("Auto-Scroll: läuft");
  requestAnimationFrame(tickAutoScroll);
}
function stopAutoScroll() {
  state.viewer.autoScroll.running = false;
  updateStatus("Auto-Scroll: pausiert");
}
function tickAutoScroll(ts) {
  if (!state.viewer.autoScroll.running) return;
  const el = $("#viewer");
  const dt = (ts - state.viewer.autoScroll.lastTs) / 1000;
  state.viewer.autoScroll.lastTs = ts;

  const delta = state.viewer.autoScroll.speedPxPerSec * dt;
  el.scrollTop = Math.min(el.scrollTop + delta, el.scrollHeight - el.clientHeight);

  if (el.scrollTop >= el.scrollHeight - el.clientHeight - 1) {
    stopAutoScroll();
    refreshPlayPauseUI();
    updateStatus("Ende erreicht");
    return;
  }
  requestAnimationFrame(tickAutoScroll);
}
function refreshPlayPauseUI() {
  const btn = $("#btnPlayPause");
  if (!btn) return;
  btn.textContent = state.viewer.autoScroll.running ? "❚❚ Pause" : "▶︎ Start";
}
function updateStatus(extra) {
  const s = $("#status");
  const p = state.viewer;
  const base = `Seiten: ${p.numPages || "?"} • Sek./Seite: ${p.secsPerPage}`;
  s.textContent = extra ? `${base} • ${extra}` : base;
}

// ===== Fullscreen & Wake Lock =====
async function toggleFullscreen() {
  const el = document.fullscreenElement || document.webkitFullscreenElement;
  if (el) { 
    if (document.exitFullscreen) await document.exitFullscreen();
    else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
  } else {
    try { 
      const docEl = document.documentElement;
      if (docEl.requestFullscreen) await docEl.requestFullscreen();
      else if (docEl.webkitRequestFullscreen) await docEl.webkitRequestFullscreen();
    } catch {}
  }
  // Kurze Verzögerung, dann Control-Bar Position aktualisieren
  setTimeout(() => {
    window.dispatchEvent(new Event("resize"));
  }, 100);
}
async function toggleWakeLock() {
  const btn = $("#btnWakeLock");
  try {
    if (!state.viewer.wakeLock) {
      if ("wakeLock" in navigator) {
        state.viewer.wakeLock = await navigator.wakeLock.request("screen");
        state.viewer.wakeLock.addEventListener("release", () => { $("#btnWakeLock").textContent = "☀︎ Screen On"; });
        btn.textContent = "☀︎ Screen On ✓";
      } else {
        btn.textContent = "☀︎ Nicht unterstützt";
      }
    } else {
      await state.viewer.wakeLock.release();
      state.viewer.wakeLock = null;
      btn.textContent = "☀︎ Screen On";
    }
  } catch { btn.textContent = "☀︎ Fehler"; }
}
