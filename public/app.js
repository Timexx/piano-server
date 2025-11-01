function mountVirtualizer(resetScroll = false) {
  const wrap = $("#virtualWrap");
  wrap.innerHTML = "";

  const L = state.library;
  let items = L.items;

  if (L.q === "__FAV__") {
    items = items.filter((x) => state.library.favorites.has(x.name));
  }

  const fuse = window.Fuse ? new Fuse(items, { keys: ["displayName", "name", "folder"], threshold: 0.3 }) : null;
  if (fuse && L.q && L.q !== "__FAV__") {
    items = fuse.search(L.q).map((r) => r.item);
  }

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
    // ===== Viewer =====
    async function renderViewer(fileName) {
      controlsEl.classList.remove("hidden");
      headerActionsEl.innerHTML = `<a href="/" class="px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 border border-neutral-700">← Library</a>`;

      appEl.innerHTML = `
        <section>
          <h1 class="sr-only">Viewer ${fileName}</h1>
          <div id="viewer" class="vh no-scrollbar overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-900"></div>
        </section>
      `;

      const container = $("#viewer");
      state.viewer.fileName = fileName;
      state.viewer.url = `/sheets/${encodePathSegments(fileName)}`;
      container.style.paddingTop = "24px";
      container.style.paddingBottom = "180px";
      container.style.boxSizing = "border-box";

      $("#btnBack").onclick = () => (location.href = "/");
      $("#btnFullscreen").onclick = toggleFullscreen;
      $("#btnWakeLock").onclick = toggleWakeLock;
      $("#btnStart").onclick = () => startAutoScroll();
      $("#btnPause").onclick = () => stopAutoScroll();

      const key = `secsPerPage:${fileName}`;
      const persisted = Number(localStorage.getItem(key));
      state.viewer.secsPerPage = Number.isFinite(persisted) && persisted > 0 ? persisted : 45;
      $("#secsPerPage").value = state.viewer.secsPerPage;
      $("#secsPerPage").addEventListener("change", (e) => {
        const v = Math.max(5, Math.min(600, Number(e.target.value || 45)));
        state.viewer.secsPerPage = v;
        localStorage.setItem(key, String(v));
        updateStatus();
        if (state.viewer.autoScroll.running) computeSpeed();
      });

      updateStatus("Lade…");
      await mountPdfVirtual(container, state.viewer.url);
      updateStatus();
    }

    async function mountPdfVirtual(container, url) {
      if (!window.pdfjsLib) {
        container.innerHTML = `<embed src="${url}" type="application/pdf" class="w-full h-full" />`;
        state.viewer.numPages = 1;
        return;
      }

      const pdf = await pdfjsLib.getDocument(url).promise;
      state.viewer.numPages = pdf.numPages;

      container.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "w-full flex flex-col items-center py-6";
      wrap.style.width = "100%";
      wrap.style.boxSizing = "border-box";
      wrap.style.rowGap = "40px";
      container.appendChild(wrap);

      for (let i = 1; i <= pdf.numPages; i++) {
        const pageWrapper = document.createElement("div");
        pageWrapper.className = "w-full flex flex-col items-center";
        pageWrapper.style.maxWidth = "1400px";
        pageWrapper.style.width = "100%";
        pageWrapper.style.boxSizing = "border-box";
        pageWrapper.style.padding = "0 24px";
        pageWrapper.style.display = "flex";
        pageWrapper.style.flexDirection = "column";
        pageWrapper.style.alignItems = "center";
        pageWrapper.style.rowGap = "16px";

        const label = document.createElement("div");
        label.className = "text-xs text-neutral-400";
        label.textContent = `Seite ${i} / ${pdf.numPages}`;
        pageWrapper.appendChild(label);

        wrap.appendChild(pageWrapper);
        await renderPageToContainer(pageWrapper, pdf, i);
      }

      if (typeof pdf.cleanup === "function") pdf.cleanup();
      if (typeof pdf.destroy === "function") pdf.destroy();
    }

    async function renderPageToContainer(wrapper, pdf, pageNum) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });

      const measureWidth = () => {
        const rect = wrapper.getBoundingClientRect();
        if (rect.width) return rect.width;
        const parentRect = wrapper.parentElement?.getBoundingClientRect();
        if (parentRect && parentRect.width) return parentRect.width;
        return 1024;
      };

      const availableWidth = Math.max(480, Math.min(1400, measureWidth() * 0.98));
      const scale = availableWidth / viewport.width;
      const scaledViewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(scaledViewport.width);
      canvas.height = Math.round(scaledViewport.height);
      canvas.className = "rounded bg-white shadow-lg";
      canvas.style.display = "block";
      canvas.style.maxWidth = "100%";
      canvas.style.width = `${Math.round(scaledViewport.width)}px`;
      canvas.style.height = `${Math.round(scaledViewport.height)}px`;
      canvas.style.border = "1px solid rgba(0,0,0,0.12)";
      canvas.style.boxShadow = "0 20px 40px rgba(15,15,25,0.35)";

      const ctx = canvas.getContext("2d", { alpha: false });
      await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;

      wrapper.appendChild(canvas);

      if (typeof page.cleanup === "function") page.cleanup();
    }

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
    Promise.resolve()
      .then(fn)
      .finally(() => {
        T.running--;
        pumpQueue();
      });
  }
}

// ===== Viewer =====
async function renderViewer(fileName) {
  const total = items.length;
  const rows = Math.ceil(total / cols);
  const totalHeight = rows * (cardH + (isGrid ? gap : 0));

  const scroller = document.createElement("div");
  wrap.className = "w-full flex flex-col items-center py-6";
  wrap.style.width = "100%";
  wrap.style.alignItems = "center";
  spacer.style.height = `${totalHeight}px`;
  spacer.style.position = "relative";
  scroller.appendChild(spacer);
  wrap.appendChild(scroller);

  const pool = new Map(); // key -> element
    pageContainer.className = "w-full flex flex-col items-center";
    pageContainer.style.maxWidth = "1440px";
    pageContainer.style.width = "100%";
    pageContainer.style.padding = "0 24px";
  controlsEl.classList.remove("hidden");
  headerActionsEl.innerHTML = `<a href="/" class="px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 border border-neutral-700">← Library</a>`;

  // Shell
  appEl.innerHTML = `
    <section>
      <h1 class="sr-only">Viewer ${fileName}</h1>
      <div id="viewer" class="vh no-scrollbar overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-900"></div>
    </section>
  `;

  const container = $("#viewer");
  state.viewer.fileName = fileName;
  state.viewer.url = `/sheets/${encodePathSegments(fileName)}`;
  // Ensure pages are not hidden by the fixed control bar
  container.style.paddingTop = "24px";
  container.style.paddingBottom = "180px"; // leave space for controls
  container.style.boxSizing = "border-box";

  // Controls
  $("#btnBack").onclick = () => (location.href = "/");
  $("#btnFullscreen").onclick = toggleFullscreen;
  $("#btnWakeLock").onclick = toggleWakeLock;
  $("#btnStart").onclick = () => startAutoScroll();
  $("#btnPause").onclick = () => stopAutoScroll();

  const key = `secsPerPage:${fileName}`;
  const persisted = Number(localStorage.getItem(key));
  state.viewer.secsPerPage = Number.isFinite(persisted) && persisted > 0 ? persisted : 45;
  $("#secsPerPage").value = state.viewer.secsPerPage;
  $("#secsPerPage").addEventListener("change", (e) => {
    const v = Math.max(5, Math.min(600, Number(e.target.value || 45)));
    state.viewer.secsPerPage = v;
    localStorage.setItem(key, String(v));
    updateStatus();
    if (state.viewer.autoScroll.running) computeSpeed();
  });

  updateStatus("Lade…");

  // Render pages on-demand (virtualized by IO)
  await mountPdfVirtual(container, state.viewer.url);

  updateStatus();
}

// Virtualized pages: nur Seiten im Sichtbereich + Puffer rendern
async function mountPdfVirtual(container, url) {
  if (!window.pdfjsLib) {
    container.innerHTML = `<embed src="${url}" type="application/pdf" class="w-full h-full" />`;
    state.viewer.numPages = 1;
    return;
  }

  const pdf = await pdfjsLib.getDocument(url).promise;
  state.viewer.numPages = pdf.numPages;

  const wrap = document.createElement("div");
  wrap.className = "w-full flex flex-col items-center py-6";
  wrap.style.gap = "32px"; // Fester Abstand zwischen Seiten
  container.innerHTML = "";
  container.appendChild(wrap);

  // Alle Seiten nacheinander rendern - keine Virtualisierung für bessere Darstellung
  for (let i = 1; i <= pdf.numPages; i++) {
    const pageContainer = document.createElement("div");
    pageContainer.className = "w-full flex flex-col items-center";
    pageContainer.innerHTML = `<div class="text-xs text-neutral-400 mb-2">Seite ${i} / ${pdf.numPages}</div>`;
    wrap.appendChild(pageContainer);
    
    // Seite sofort rendern
    await renderPageToContainer(pageContainer, pdf, i);
  }
  
  // Cleanup
  if (typeof pdf.cleanup === "function") pdf.cleanup();
  if (typeof pdf.destroy === "function") pdf.destroy();
}

async function renderPageToContainer(container, pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  
  // Viewport berechnen - für DIN A4 optimal
  const viewport = page.getViewport({ scale: 1.0 });
  
  // Skalierung: Container-Breite berücksichtigen, max 1400px
  const containerWidth = Math.min(1400, container.parentElement.clientWidth * 0.95);
  const scale = containerWidth / viewport.width;
  const scaledViewport = page.getViewport({ scale });
  
  const canvas = document.createElement("canvas");
  canvas.width = scaledViewport.width;
  canvas.height = scaledViewport.height;
  canvas.className = "rounded bg-white shadow-lg";
  // Wichtig: Canvas auf tatsächliche Pixelgröße setzen
  canvas.style.width = `${scaledViewport.width}px`;
  canvas.style.height = `${scaledViewport.height}px`;
  canvas.style.maxWidth = "100%";
  canvas.style.height = "auto"; // Aspect Ratio beibehalten
  
  const ctx = canvas.getContext("2d", { alpha: false });
  
  await page.render({
    canvasContext: ctx,
    viewport: scaledViewport
  }).promise;
  
  container.appendChild(canvas);
  
  // Cleanup
  if (typeof page.cleanup === "function") page.cleanup();
}

async function renderPageToContainer(container, pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  
  // Viewport berechnen - für DIN A4 optimal
  const viewport = page.getViewport({ scale: 1.0 });
  
  // Skalierung: Container-Breite berücksichtigen, max 1400px
  const containerWidth = Math.min(1400, container.parentElement.clientWidth * 0.95);
  const scale = containerWidth / viewport.width;
  const scaledViewport = page.getViewport({ scale });
  
  const canvas = document.createElement("canvas");
  canvas.width = scaledViewport.width;
  canvas.height = scaledViewport.height;
  canvas.className = "rounded bg-white shadow-lg";
  // Wichtig: Canvas auf tatsächliche Pixelgröße setzen
  canvas.style.width = `${scaledViewport.width}px`;
  canvas.style.height = `${scaledViewport.height}px`;
  canvas.style.maxWidth = "100%";
  canvas.style.height = "auto"; // Aspect Ratio beibehalten
  
  const ctx = canvas.getContext("2d", { alpha: false });
  
  await page.render({
    canvasContext: ctx,
    viewport: scaledViewport
  }).promise;
  
  container.appendChild(canvas);
  
  // Cleanup
  if (typeof page.cleanup === "function") page.cleanup();
}

async function computeFitWidthScale(page, container) {
  const unscaled = page.getViewport({ scale: 1 });
  const pad = 24;
  const containerWidth = container.clientWidth - pad;
  const maxWidth = Math.min(1400, containerWidth * 0.95); // gut lesbar
  const scale = maxWidth / unscaled.width;
  return Math.max(0.6, Math.min(scale, 3.0));
}

// ===== Auto Scroll =====
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
    updateStatus("Ende erreicht");
    return;
  }
  requestAnimationFrame(tickAutoScroll);
}
function updateStatus(extra) {
  const s = $("#status");
  const p = state.viewer;
  const base = `Seiten: ${p.numPages || "?"} • Sek./Seite: ${p.secsPerPage}`;
  s.textContent = extra ? `${base} • ${extra}` : base;
}

// ===== Fullscreen & Wake Lock =====
async function toggleFullscreen() {
  const el = document.fullscreenElement;
  if (el) { await document.exitFullscreen(); return; }
  try { await document.documentElement.requestFullscreen(); } catch {}
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