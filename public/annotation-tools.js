const COLOR_PRESETS = [
  "#FFFFFF",
  "#FDE68A",
  "#F97316",
  "#F87171",
  "#10B981",
  "#38BDF8",
  "#A855F7",
  "#94A3B8"
];

const TOOL_CONFIG = {
  pen: { widthMultiplier: 1, alpha: 1 },
  highlighter: { widthMultiplier: 2.4, alpha: 0.35 }
};

export function createAnnotationManager({ state, updateStatus, fetcher, onSaved }) {
  const pages = new Map();
  const pendingPages = new Set();
  const options = {
    tool: "pen",
    color: COLOR_PRESETS[1],
    size: 3,
    highlightAlpha: 0.35
  };

  // Keep payloads well below server limit to avoid 500s on large zoom levels
  const MAX_UPLOAD_BYTES = 9 * 1024 * 1024; // server rejects at 10MB
  const MAX_COMPRESSION_ATTEMPTS = 3;

  const controls = {
    initialized: false,
    root: null,
    toggle: null,
    panel: null,
    toolbar: null,
    toolButtons: [],
    colorButtons: [],
    sizeInput: null,
    sizeValue: null,
    undoBtn: null,
    clearBtn: null
  };

  let fileName = null;
  let active = false;
  let saveTimer = null;
  let saving = false;
  let lastActivePage = null;
  let statusResetTimer = null;

  function initControls() {
    // console.log('[Annotation] initControls called, already initialized?', controls.initialized);
    if (controls.initialized) return;
    
    controls.root = document.getElementById("annotationControls");
    // console.log('[Annotation] controls.root:', controls.root);
    if (!controls.root) return;

    controls.toggle = document.getElementById("btnAnnotationToggle");
    // console.log('[Annotation] controls.toggle:', controls.toggle);
    
    controls.panel = document.getElementById("annotationPanel");
    // console.log('[Annotation] controls.panel:', controls.panel);
    
    controls.toolbar = document.getElementById("annotationToolbar");
    // console.log('[Annotation] controls.toolbar:', controls.toolbar);
    if (controls.toolbar && !controls.toolbar.dataset.detachedToBody) {
      document.body.appendChild(controls.toolbar);
      controls.toolbar.dataset.detachedToBody = "1";
    }

    controls.sizeInput = document.getElementById("annotationSize");
    controls.sizeValue = document.getElementById("annotationSizeValue");
    controls.undoBtn = document.getElementById("btnAnnotationUndo");
    controls.clearBtn = document.getElementById("btnAnnotationClear");

    if (controls.toolbar) {
      controls.toolbar.setAttribute("aria-hidden", controls.toolbar.classList.contains("hidden") ? "true" : "false");
    }

    // Close annotations automatically when the control bar is minimized
    const controlsRoot = document.getElementById("controls");
    if (controlsRoot && typeof MutationObserver === "function") {
      const mo = new MutationObserver(() => {
        const minimized = controlsRoot.classList.contains("controls-minimized");
        if (minimized && active) {
          setActiveState(false, { silent: true, force: true });
        }
      });
      mo.observe(controlsRoot, { attributes: true, attributeFilter: ["class"] });
    }

    const toolButtons = controls.panel ? Array.from(controls.panel.querySelectorAll(".annotation-tool-btn")) : [];
    controls.toolButtons = toolButtons;

    const colorsContainer = document.getElementById("annotationColors");
    if (colorsContainer) {
      colorsContainer.innerHTML = "";
      COLOR_PRESETS.forEach((color) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "annotation-color-btn";
        btn.style.setProperty("--annotation-color", color);
        btn.dataset.color = color;
        btn.setAttribute("aria-pressed", color === options.color ? "true" : "false");
        btn.title = color;
        btn.addEventListener("click", () => selectColor(color));
        colorsContainer.appendChild(btn);
        controls.colorButtons.push(btn);
      });
    }

    toolButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tool = btn.dataset.tool;
        if (tool) selectTool(tool);
      });
    });

    if (controls.toggle) {
      // console.log('[Annotation] Adding click listener to toggle button');
      controls.toggle.addEventListener("click", () => {
        // console.log('[Annotation] Toggle button clicked! Current active:', active);
        setActiveState(!active);
      });
    } else {
      console.warn('[Annotation] Toggle button not found!');
    }

    if (controls.sizeInput) {
      controls.sizeInput.value = String(options.size);
      controls.sizeInput.addEventListener("input", (event) => {
        setSize(Number(event.target.value));
      });
    }

    if (controls.undoBtn) {
      controls.undoBtn.addEventListener("click", () => { void undoLastStroke(); });
    }

    if (controls.clearBtn) {
      controls.clearBtn.addEventListener("click", () => clearCurrentPage());
    }

    updateToggleUI();
    updateToolButtons();
    updateColorButtons();
    updateSizeReadout();

    controls.initialized = true;
  }

  function enterViewer({ fileName: nextFile }) {
    flushSaves();
    resetPages();
    fileName = nextFile || null;
    lastActivePage = null;
    setActiveState(false, { silent: true, force: true });
    updateToggleUI();
    refreshOverlayActivation();
    clearStatusTimer();
    updateStatus();
  }

  function leaveViewer() {
    flushSaves();
    setActiveState(false, { silent: true, force: true });
    fileName = null;
    refreshOverlayActivation();
  }

  function resetPages() {
    pages.forEach((entry) => {
      if (entry.overlay && entry.overlay.isConnected) {
        entry.overlay.remove();
      }
      if (entry.commitCanvas && entry.commitCanvas.isConnected) {
        entry.commitCanvas.remove();
      }
    });
    pages.clear();
    pendingPages.clear();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saving = false;
  }

  function attachPageLayer(params) {
    if (!params || !params.pageNumber) return;
    const entry = ensureEntry(params.pageNumber);
    entry.frame = params.frame || entry.frame;
    entry.pageWidth = params.pageWidth || entry.pageWidth;
    entry.pageHeight = params.pageHeight || entry.pageHeight;
    entry.renderWidth = params.renderWidth || entry.renderWidth;
    entry.renderHeight = params.renderHeight || entry.renderHeight;
    entry.displayWidth = params.displayWidth || entry.displayWidth;
    entry.displayHeight = params.displayHeight || entry.displayHeight;
    entry.pixelRatio = entry.renderWidth && entry.displayWidth
      ? entry.renderWidth / Math.max(entry.displayWidth, 1)
      : 1;

    const frame = params.frame;
    if (!frame) return;

    const overlay = ensureOverlay(entry, frame);
    const committed = ensureCommitCanvas(entry, frame);

    resizeCanvas(committed, entry.renderWidth, entry.renderHeight, entry.displayWidth, entry.displayHeight);
    resizeCanvas(overlay, entry.renderWidth, entry.renderHeight, entry.displayWidth, entry.displayHeight);

    if (committed && overlay && committed.nextSibling !== overlay) {
      frame.insertBefore(committed, overlay);
    }

    if (entry.committedImage) {
      renderCommittedImage(entry, entry.committedImage);
    }

    redraw(entry);
    refreshOverlayActivationForEntry(entry);
  }

  function refreshOverlayActivation() {
    pages.forEach((entry) => refreshOverlayActivationForEntry(entry));
  }

  function refreshOverlayActivationForEntry(entry) {
    if (!entry || !entry.overlay) return;
    const isActive = active && Boolean(fileName);
    entry.overlay.classList.toggle("is-active", isActive);
    entry.overlay.classList.toggle("is-disabled", !isActive);
    entry.overlay.style.pointerEvents = isActive ? "auto" : "none";
    entry.overlay.style.touchAction = isActive ? "none" : "auto";
  }

  function onPageLayerRemoved(pageNumber) {
    const entry = pages.get(pageNumber);
    if (!entry) return;
    entry.overlay = null;
    entry.overlayCtx = null;
    entry.commitCanvas = null;
    entry.commitCtx = null;
    entry.frame = null;
    entry.renderWidth = 0;
    entry.renderHeight = 0;
    entry.displayWidth = 0;
    entry.displayHeight = 0;
    entry.pixelRatio = 1;
    entry.activePointers.clear();
  }

  function ensureEntry(pageNumber) {
    let entry = pages.get(pageNumber);
    if (!entry) {
      entry = {
        pageNumber,
        pageWidth: 0,
        pageHeight: 0,
        renderWidth: 0,
        renderHeight: 0,
        displayWidth: 0,
        displayHeight: 0,
        pixelRatio: 1,
        frame: null,
        overlay: null,
        overlayCtx: null,
        commitCanvas: null,
        commitCtx: null,
  committedImage: null,
  activePointers: new Map(),
  strokes: [],
  dirty: false,
  overlayDirty: false,
  commitDirty: false,
  needsUpload: false,
  hasCommittedContent: false
      };
      pages.set(pageNumber, entry);
    }
    return entry;
  }

  function primeCommittedImage(pageNumber, payload) {
    const entry = ensureEntry(pageNumber);
    const dataUrl = payload?.dataUrl || null;
    if (Number.isFinite(payload?.pageWidth)) entry.pageWidth = payload.pageWidth;
    if (Number.isFinite(payload?.pageHeight)) entry.pageHeight = payload.pageHeight;
    entry.committedImage = dataUrl;
    entry.hasCommittedContent = Boolean(dataUrl);
    entry.needsUpload = false;
    entry.overlayDirty = false;
    entry.commitDirty = false;
    if (entry.commitCanvas && entry.commitCtx) {
      if (dataUrl) {
        renderCommittedImage(entry, dataUrl);
      } else {
        entry.commitCtx.clearRect(0, 0, entry.commitCanvas.width, entry.commitCanvas.height);
      }
    }
  }

  function ensureOverlay(entry, frame) {
    if (entry.overlay && entry.overlay.isConnected && entry.overlay.parentElement === frame) {
      entry.overlayCtx = entry.overlay.getContext("2d");
      return entry.overlay;
    }

    const overlay = document.createElement("canvas");
    overlay.className = "annotation-layer";
    overlay.dataset.pageNumber = String(entry.pageNumber);
    overlay.addEventListener("pointerdown", (event) => handlePointerDown(event, entry));
    overlay.addEventListener("pointermove", (event) => handlePointerMove(event, entry));
    overlay.addEventListener("pointerup", (event) => handlePointerEnd(event, entry, true));
    overlay.addEventListener("pointercancel", (event) => handlePointerEnd(event, entry, false));
    overlay.addEventListener("pointerleave", (event) => handlePointerEnd(event, entry, false));
    frame.appendChild(overlay);
    entry.overlay = overlay;
    entry.overlayCtx = overlay.getContext("2d");
    return overlay;
  }

  function ensureCommitCanvas(entry, frame) {
    if (entry.commitCanvas && entry.commitCanvas.isConnected && entry.commitCanvas.parentElement === frame) {
      entry.commitCtx = entry.commitCanvas.getContext("2d");
      return entry.commitCanvas;
    }

    const canvas = document.createElement("canvas");
    canvas.className = "annotation-committed";
    canvas.style.pointerEvents = "none";
    frame.appendChild(canvas);
    entry.commitCanvas = canvas;
    entry.commitCtx = canvas.getContext("2d");
    return canvas;
  }

  function resizeCanvas(canvas, width, height, cssWidth, cssHeight) {
    if (!canvas) return;
    canvas.width = Math.max(1, Math.floor(width || 0));
    canvas.height = Math.max(1, Math.floor(height || 0));
    canvas.style.width = `${Math.max(1, Math.round(cssWidth || width || 0))}px`;
    canvas.style.height = `${Math.max(1, Math.round(cssHeight || height || 0))}px`;
  }

  function estimateBase64Size(dataUrl) {
    if (!dataUrl || typeof dataUrl !== "string") return 0;
    const idx = dataUrl.indexOf(",");
    const base64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
    return Math.floor((base64.length * 3) / 4);
  }

  function scaleCanvas(source, scale) {
    const target = document.createElement("canvas");
    target.width = Math.max(1, Math.round(source.width * scale));
    target.height = Math.max(1, Math.round(source.height * scale));
    const ctx = target.getContext("2d");
    ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, target.width, target.height);
    return target;
  }

  function serializeCanvasPngLimited(canvas) {
    if (!canvas || !canvas.width || !canvas.height) return null;

    let current = canvas;
    let dataUrl = current.toDataURL("image/png");
    let sizeBytes = estimateBase64Size(dataUrl);

    for (let attempt = 0; attempt < MAX_COMPRESSION_ATTEMPTS && sizeBytes > MAX_UPLOAD_BYTES; attempt += 1) {
      const shrinkRatio = Math.sqrt(MAX_UPLOAD_BYTES / Math.max(1, sizeBytes));
      // Prevent endless loops when the size is only slightly over the limit
      const safeRatio = Math.min(0.95, shrinkRatio);
      const scaled = scaleCanvas(current, safeRatio);
      current = scaled;
      dataUrl = current.toDataURL("image/png");
      sizeBytes = estimateBase64Size(dataUrl);
    }

    return dataUrl;
  }

  function handlePointerDown(event, entry) {
    if (!active || !fileName) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!entry.overlay) return;

    entry.overlay.setPointerCapture(event.pointerId);
    const point = getNormalizedPoint(event, entry);
    const stroke = createStroke(point);
    entry.strokes.push(stroke);
    entry.activePointers.set(event.pointerId, stroke);
    lastActivePage = entry.pageNumber;
    paintStroke(entry, stroke);
    entry.overlayDirty = true;
    entry.dirty = true;
    entry.needsUpload = true;
    event.preventDefault();
  }

  function handlePointerMove(event, entry) {
    const stroke = entry.activePointers.get(event.pointerId);
    if (!stroke) return;
    const point = getNormalizedPoint(event, entry);
    const lastPoint = stroke.points[stroke.points.length - 1];
    if (Math.abs(point.x - lastPoint.x) + Math.abs(point.y - lastPoint.y) < 0.0005) {
      event.preventDefault();
      return;
    }
    stroke.points.push(point);
    paintStrokeSegment(entry, stroke);
    entry.overlayDirty = true;
    entry.dirty = true;
    entry.needsUpload = true;
    event.preventDefault();
  }

  function handlePointerEnd(event, entry, shouldQueue) {
    const stroke = entry.activePointers.get(event.pointerId);
    if (!stroke) return;
    entry.activePointers.delete(event.pointerId);
    try { entry.overlay?.releasePointerCapture(event.pointerId); } catch {}

    entry.dirty = entry.strokes.length > 0;
    if (shouldQueue) {
      queueSave(entry.pageNumber);
      if (!entry.overlayDirty) {
        entry.strokes = [];
      }
    }
    event.preventDefault();
  }

  function createStroke(startPoint) {
    const cfg = TOOL_CONFIG[options.tool] || TOOL_CONFIG.pen;
    return {
      tool: options.tool,
      color: options.color,
      size: Math.max(1, options.size),
      alpha: options.tool === "highlighter" ? options.highlightAlpha : 1,
      widthMultiplier: cfg.widthMultiplier || 1,
      points: [startPoint]
    };
  }

  function paintStroke(entry, stroke) {
    if (!entry.overlayCtx) return;
    const ctx = entry.overlayCtx;
    ctx.save();
    applyStrokeStyle(ctx, stroke, entry.pixelRatio || 1);
    renderStroke(ctx, entry, stroke.points, false);
    ctx.restore();
  }

  function paintStrokeSegment(entry, stroke) {
    if (!entry.overlayCtx) return;
    const ctx = entry.overlayCtx;
    ctx.save();
    applyStrokeStyle(ctx, stroke, entry.pixelRatio || 1);
    renderStroke(ctx, entry, stroke.points, true);
    ctx.restore();
  }

  function mergeOverlayIntoCommitted(entry) {
    if (!entry.overlay || !entry.commitCanvas || !entry.commitCtx || !entry.overlayCtx) return;
    if (isCanvasEmpty(entry.overlay)) {
      entry.overlayCtx.clearRect(0, 0, entry.overlay.width, entry.overlay.height);
      return;
    }
    entry.commitCtx.save();
    entry.commitCtx.globalCompositeOperation = "source-over";
    entry.commitCtx.drawImage(entry.overlay, 0, 0, entry.commitCanvas.width, entry.commitCanvas.height);
    entry.commitCtx.restore();
    entry.overlayCtx.clearRect(0, 0, entry.overlay.width, entry.overlay.height);
  }

  function isCanvasEmpty(canvas) {
    if (!canvas) return true;
    const { width, height } = canvas;
    if (!width || !height) return true;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    try {
      const data = ctx.getImageData(0, 0, width, height).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 0) return false;
      }
    } catch (err) {
      console.warn("Canvas empty check failed", err);
      return false;
    }
    return true;
  }

  function applyStrokeStyle(ctx, stroke, ratio) {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.color;
    ctx.globalAlpha = stroke.alpha ?? 1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const multiplier = stroke.widthMultiplier || 1;
    ctx.lineWidth = Math.max(0.5, stroke.size * multiplier * ratio);
  }

  function renderStroke(ctx, entry, points, onlyTail = false) {
    if (!entry.overlay) return;
    if (!points.length) return;
    if (points.length === 1) {
      const p = toCanvasPoint(entry, points[0]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + 0.02, p.y + 0.02);
      ctx.stroke();
      return;
    }

    const startIndex = onlyTail ? Math.max(1, points.length - 1) : 1;
    for (let idx = startIndex; idx < points.length; idx++) {
      const prev = toCanvasPoint(entry, points[idx - 1]);
      const curr = toCanvasPoint(entry, points[idx]);
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(curr.x, curr.y);
      ctx.stroke();
    }
  }

  function redraw(entry) {
    if (!entry.overlayCtx || !entry.overlay) return;
    entry.overlayCtx.clearRect(0, 0, entry.overlay.width, entry.overlay.height);
    entry.strokes.forEach((stroke) => paintStroke(entry, stroke));
  }

  function queueSave(pageNumber) {
    if (!fileName) return;
    const entry = pages.get(pageNumber);
    if (entry) entry.needsUpload = true;
    pendingPages.add(pageNumber);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      flushSaves();
    }, 800);
  }

  async function flushSaves() {
    if (saving || !fileName) return;
    if (!pendingPages.size) return;

    const items = [];
    pendingPages.forEach((pageNumber) => {
      const entry = pages.get(pageNumber);
      if (!entry) return;

      if (entry.overlayDirty) {
        mergeOverlayIntoCommitted(entry);
      }

      let dataUrl = null;
      if (entry.commitCanvas && entry.needsUpload) {
        if (!isCanvasEmpty(entry.commitCanvas)) {
          try {
            dataUrl = serializeCanvasPngLimited(entry.commitCanvas);
          } catch (err) {
            console.warn("Annotation serialization failed", err);
          }
        }
      }

      entry.strokes = [];
      entry.overlayDirty = false;
      entry.commitDirty = false;

      if (!entry.needsUpload && !dataUrl) {
        // Nothing to send
        entry.needsUpload = false;
        return;
      }

      entry.needsUpload = false;
      if (!dataUrl) {
        entry.committedImage = null;
        entry.hasCommittedContent = false;
        if (entry.commitCtx && entry.commitCanvas) {
          entry.commitCtx.clearRect(0, 0, entry.commitCanvas.width, entry.commitCanvas.height);
        }
      } else {
        entry.committedImage = dataUrl;
        entry.hasCommittedContent = true;
      }

      items.push({ entry, payload: {
        pageNumber,
        dataUrl,
        pageWidth: entry.pageWidth,
        pageHeight: entry.pageHeight
      }});
    });

    pendingPages.clear();
    if (!items.length) return;

    saving = true;
    items.forEach(({ entry }) => markSaving(entry, true));
    showStatus("Notizen speichern…");

    try {
      const response = await (fetcher || window.fetch)("/api/annotations/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: fileName, overlays: items.map((item) => item.payload) }),
        cache: "no-store"
      });

      if (!response.ok) {
        let serverMessage = null;
        try {
          const payload = await response.json();
          if (payload && typeof payload.error === "string") {
            serverMessage = payload.error;
          }
        } catch {}
        const err = new Error(serverMessage ? serverMessage : `HTTP ${response.status}`);
        err.status = response.status;
        err.userMessage = serverMessage;
        throw err;
      }

      let result = null;
      try {
        result = await response.json();
      } catch {}

      showStatus("Notizen gespeichert", 1600);
      if (typeof onSaved === "function") {
        const changedPages = Array.from(new Set(items.map(({ payload }) => payload.pageNumber).filter((page) => Number.isInteger(page) && page > 0)));
        const mtimeValue = Number(result?.mtime);
        const sizeValue = Number(result?.size);
        onSaved({
          mtime: Number.isFinite(mtimeValue) ? mtimeValue : null,
          size: Number.isFinite(sizeValue) ? sizeValue : null,
          pages: changedPages
        });
      }
    } catch (err) {
      console.error("Annotation save failed", err);
      const message = typeof err?.userMessage === "string" && err.userMessage.trim()
        ? err.userMessage
        : "Speichern fehlgeschlagen";
      showStatus(message, 2000);
      items.forEach(({ entry }) => {
        pendingPages.add(entry.pageNumber);
      });
    } finally {
      items.forEach(({ entry }) => markSaving(entry, false));
      saving = false;
      if (pendingPages.size) flushSaves();
    }
  }

  function markSaving(entry, flag) {
    if (!entry.overlay) return;
    entry.overlay.classList.toggle("is-saving", flag);
  }

  function renderCommittedImage(entry, dataUrl) {
    if (!entry.commitCanvas || !entry.commitCtx) return;
    entry.commitCtx.clearRect(0, 0, entry.commitCanvas.width, entry.commitCanvas.height);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (!entry.commitCtx) return;
      entry.commitCtx.clearRect(0, 0, entry.commitCanvas.width, entry.commitCanvas.height);
      entry.commitCtx.drawImage(img, 0, 0, entry.commitCanvas.width, entry.commitCanvas.height);
      entry.hasCommittedContent = Boolean(dataUrl);
    };
    img.src = dataUrl;
  }

  async function undoLastStroke() {
    if (undoPendingStroke()) return;
    await undoPreviousVersion();
  }

  function undoPendingStroke() {
    const pageOrder = lastActivePage ? [lastActivePage, ...Array.from(pages.keys()).filter((n) => n !== lastActivePage).reverse()] : Array.from(pages.keys()).reverse();
    for (const pageNumber of pageOrder) {
      const entry = pages.get(pageNumber);
      if (!entry || !entry.strokes.length) continue;
      entry.strokes.pop();
      redraw(entry);
      if (entry.strokes.length) {
        queueSave(pageNumber);
      } else {
        pendingPages.delete(pageNumber);
        entry.dirty = false;
        if (entry.overlayCtx && entry.overlay) {
          entry.overlayCtx.clearRect(0, 0, entry.overlay.width, entry.overlay.height);
        }
        showStatus("Notiz entfernt", 1200);
      }
      return true;
    }
    return false;
  }

  async function undoPreviousVersion() {
    if (!fileName) {
      showStatus("Keine Datei ausgewählt", 1400);
      return;
    }
    if (saving) {
      showStatus("Bitte warten, Notizen werden gespeichert", 1600);
      return;
    }

    showStatus("Vorherige Version laden…");
    try {
      const response = await (fetcher || window.fetch)("/api/annotations/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: fileName }),
        cache: "no-store"
      });

      if (response.status === 409) {
        showStatus("Keine ältere Version vorhanden", 1600);
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      const snapshots = Array.isArray(payload?.pages) ? payload.pages : [];
      const snapshotMap = new Map();
      snapshots.forEach((item) => {
        const pageNumber = Number(item?.pageNumber);
        if (!Number.isInteger(pageNumber) || pageNumber < 1) return;
        if (typeof item?.dataUrl !== "string") return;
        snapshotMap.set(pageNumber, item);
      });

      const beforePages = Array.from(pages.keys());
      const changedSet = new Set([...beforePages, ...snapshotMap.keys()]);

      pendingPages.clear();
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }

      pages.forEach((entry, pageNumber) => {
        entry.strokes = [];
        entry.activePointers.clear();
        entry.dirty = false;
        entry.overlayDirty = false;
        entry.commitDirty = false;
        entry.needsUpload = false;
        if (entry.overlayCtx && entry.overlay) {
          entry.overlayCtx.clearRect(0, 0, entry.overlay.width, entry.overlay.height);
        }
        const snapshot = snapshotMap.get(pageNumber);
        if (snapshot) {
          primeCommittedImage(pageNumber, snapshot);
        } else {
          primeCommittedImage(pageNumber, { pageNumber, dataUrl: null });
        }
      });

      snapshotMap.forEach((snapshot, pageNumber) => {
        if (!pages.has(pageNumber)) {
          primeCommittedImage(pageNumber, snapshot);
        }
      });

      lastActivePage = null;
      showStatus("Vorherige Version geladen", 1600);

      const mtimeValue = Number(payload?.mtime);
      const sizeValue = Number(payload?.size);
      const changedPages = Array.from(changedSet).filter((page) => Number.isInteger(page) && page > 0);
      if (typeof onSaved === "function") {
        onSaved({
          mtime: Number.isFinite(mtimeValue) ? mtimeValue : null,
          size: Number.isFinite(sizeValue) ? sizeValue : null,
          pages: changedPages
        });
      }
    } catch (err) {
      console.error("Annotation version undo failed", err);
      showStatus("Version konnte nicht geladen werden", 2000);
    }
  }

  function getMostVisiblePageNumber() {
    const container = document.querySelector('#viewer');
    if (!container) return null;
    const containerRect = container.getBoundingClientRect();
    let bestPage = null;
    let bestScore = 0;
    const pageNodes = container.querySelectorAll('.viewer-page[data-page]');
    pageNodes.forEach((node) => {
      const rect = node.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(rect.bottom, containerRect.bottom) - Math.max(rect.top, containerRect.top));
      if (overlap > bestScore + 0.5) {
        const pageNumber = Number(node.dataset.page);
        if (Number.isInteger(pageNumber) && pageNumber > 0) {
          bestScore = overlap;
          bestPage = pageNumber;
        }
      }
    });
    return bestPage;
  }

  function clearCurrentPage() {
    let targetPage = lastActivePage;
    if (!targetPage) {
      targetPage = getMostVisiblePageNumber();
      if (targetPage) {
        lastActivePage = targetPage;
      }
    }

    if (!targetPage) {
      showStatus("Keine Seite im Fokus", 1400);
      return;
    }

    const entry = pages.get(targetPage);
    if (!entry) {
      showStatus("Seite nicht geladen", 1400);
      return;
    }

    let hadContent = false;

    if (entry.overlayCtx && entry.overlay) {
      entry.overlayCtx.clearRect(0, 0, entry.overlay.width, entry.overlay.height);
      if (entry.strokes.length) hadContent = true;
    }

    if (entry.commitCtx && entry.commitCanvas && !isCanvasEmpty(entry.commitCanvas)) {
      entry.commitCtx.clearRect(0, 0, entry.commitCanvas.width, entry.commitCanvas.height);
      hadContent = true;
    }

    entry.strokes = [];
    entry.activePointers.clear();
    entry.dirty = false;
    entry.overlayDirty = false;
    entry.commitDirty = false;
    entry.needsUpload = hadContent;
    entry.hasCommittedContent = false;
    entry.committedImage = null;

    if (hadContent) {
      pendingPages.add(entry.pageNumber);
      queueSave(entry.pageNumber);
      showStatus("Seite geleert", 1600);
    } else {
      showStatus("Keine Notizen vorhanden", 1200);
    }
  }

  function getNormalizedPoint(event, entry) {
    const target = entry.frame || event.currentTarget;
    const rect = target.getBoundingClientRect();
    const nx = (event.clientX - rect.left) / Math.max(rect.width, 1);
    const ny = (event.clientY - rect.top) / Math.max(rect.height, 1);
    return {
      x: Math.min(1, Math.max(0, nx)),
      y: Math.min(1, Math.max(0, ny))
    };
  }

  function toCanvasPoint(entry, point) {
    const overlay = entry.overlay;
    const width = overlay ? overlay.width : 1;
    const height = overlay ? overlay.height : 1;
    return {
      x: point.x * width,
      y: point.y * height
    };
  }

  function setActiveState(next, opts = {}) {
    const changed = opts.force ? true : next !== active;
    // console.log('[Annotation] setActiveState called - next:', next, 'current active:', active, 'changed:', changed, 'opts:', opts);
    if (!changed) return;
    active = next;
    // console.log('[Annotation] Active state changed to:', active);
    updateToggleUI();
    refreshOverlayActivation();
    if (!opts.silent) {
      if (active) showStatus("Notizen aktiv", 1400);
      else updateStatus();
    }

    // Auto-close when controls are minimized (class toggled elsewhere)
    const controlsRoot = document.getElementById("controls");
    if (controlsRoot && controlsRoot.classList.contains("controls-minimized") && active) {
      setActiveState(false, { silent: true, force: true });
      return;
    }
  }

  function selectTool(tool) {
    if (!TOOL_CONFIG[tool]) tool = "pen";
    if (options.tool === tool) return;
    options.tool = tool;
    updateToolButtons();
  }

  function selectColor(color) {
    options.color = color;
    updateColorButtons();
  }

  function setSize(value) {
    const clamped = Math.max(1, Math.min(8, Math.round(value || options.size)));
    options.size = clamped;
    if (controls.sizeInput) controls.sizeInput.value = String(clamped);
    updateSizeReadout();
  }

  function updateToggleUI() {
    if (!controls.toggle) return;

    // console.log('[Annotation] updateToggleUI - active:', active);

    if (active) {
      controls.toggle.classList.add("annotation-toggle-active");
    } else {
      controls.toggle.classList.remove("annotation-toggle-active");
    }
    controls.toggle.setAttribute("aria-pressed", active ? "true" : "false");
    
    // Toolbar visibility - SIMPLE: just toggle is-open class
    if (controls.toolbar) {
      // console.log('[Annotation] Toolbar element:', controls.toolbar);
      if (active) {
        controls.toolbar.classList.add("is-open");
        controls.toolbar.style.display = "flex";
        // console.log('[Annotation] Added is-open class. Toolbar classes:', controls.toolbar.className);
      } else {
        controls.toolbar.classList.remove("is-open");
        controls.toolbar.style.display = "none";
      }
      controls.toolbar.setAttribute("aria-hidden", active ? "false" : "true");
    }
  }

  function updateToolButtons() {
    controls.toolButtons.forEach((btn) => {
      const pressed = btn.dataset.tool === options.tool;
      btn.setAttribute("aria-pressed", pressed ? "true" : "false");
    });
  }

  function updateColorButtons() {
    controls.colorButtons.forEach((btn) => {
      const pressed = btn.dataset.color === options.color;
      btn.setAttribute("aria-pressed", pressed ? "true" : "false");
    });
  }

  function updateSizeReadout() {
    if (controls.sizeValue) controls.sizeValue.textContent = String(options.size);
  }

  function showStatus(message, delay) {
    clearStatusTimer();
    if (!message) {
      updateStatus();
      return;
    }
    updateStatus(message);
    if (delay && delay > 0) {
      statusResetTimer = window.setTimeout(() => {
        statusResetTimer = null;
        updateStatus();
      }, delay);
    }
  }

  function clearStatusTimer() {
    if (statusResetTimer) {
      clearTimeout(statusResetTimer);
      statusResetTimer = null;
    }
  }

  const api = {
    initControls,
    enterViewer,
    leaveViewer,
    attachPageLayer,
    refreshOverlayActivation,
    onPageLayerRemoved,
    isActive: () => active
  };

  Object.defineProperty(api, "primeCommittedImage", {
    value: (pageNumber, payload) => primeCommittedImage(pageNumber, payload),
    enumerable: true
  });

  return api;
}
