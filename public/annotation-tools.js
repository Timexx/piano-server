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
  const STORAGE_SCALE = 2;
  const MAX_STORAGE_DIM = 4096;
  const IDLE_SAVE_DELAY = 1200;
  const MAX_PENDING_AGE = 5000;
  const SAVE_STATUS_DELAY = 500;

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
  let idleCallback = null;
  let pendingSince = null;
  let saving = false;
  let lastActivePage = null;
  let statusResetTimer = null;
  let saveStatusTimer = null;
  let lastInputTs = 0;

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
    finalizeActiveStrokes();
    void flushSaves({ force: true });
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
    finalizeActiveStrokes();
    void flushSaves({ force: true });
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
    if (idleCallback && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(idleCallback);
      idleCallback = null;
    }
    pendingSince = null;
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
    ensureStorageCanvas(entry);
    renderAllFromActions(entry);
    redrawOverlay(entry);
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
        storageCanvas: null,
        storageCtx: null,
        storageWidth: 0,
        storageHeight: 0,
        storageScale: 1,
        committedImage: null,
        committedImageEl: null,
        committedImageToken: 0,
        activePointers: new Map(),
        actions: [],
        redo: [],
        dirty: false,
        overlayDirty: false,
        overlayNeedsFullRedraw: false,
        needsUpload: false,
        hasCommittedContent: false
      };
      pages.set(pageNumber, entry);
    }
    return entry;
  }

  function computeStorageSize(entry) {
    const fallbackWidth = entry.commitCanvas?.width || entry.renderWidth || entry.displayWidth || 0;
    const fallbackHeight = entry.commitCanvas?.height || entry.renderHeight || entry.displayHeight || 0;
    const baseWidth = Number(entry.pageWidth || fallbackWidth || 0);
    const baseHeight = Number(entry.pageHeight || fallbackHeight || 0);
    if (!Number.isFinite(baseWidth) || !Number.isFinite(baseHeight) || baseWidth <= 0 || baseHeight <= 0) {
      return null;
    }
    let scale = STORAGE_SCALE;
    const maxDim = Math.max(baseWidth, baseHeight) * scale;
    if (maxDim > MAX_STORAGE_DIM) {
      scale *= MAX_STORAGE_DIM / Math.max(1, maxDim);
    }
    const width = Math.max(1, Math.round(baseWidth * scale));
    const height = Math.max(1, Math.round(baseHeight * scale));
    return { width, height, scale };
  }

  function ensureStorageCanvas(entry) {
    const size = computeStorageSize(entry);
    if (!size) return false;
    const needsNew = !entry.storageCanvas || entry.storageWidth !== size.width || entry.storageHeight !== size.height;
    if (!needsNew) return false;

    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    entry.storageCanvas = canvas;
    entry.storageCtx = canvas.getContext("2d");
    entry.storageWidth = size.width;
    entry.storageHeight = size.height;
    entry.storageScale = size.scale;
    return true;
  }

  function clearCanvas(ctx, canvas) {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = (err) => reject(err);
      img.src = dataUrl;
    });
  }

  function getLastClearIndex(entry) {
    if (!entry || !entry.actions || !entry.actions.length) return -1;
    for (let idx = entry.actions.length - 1; idx >= 0; idx -= 1) {
      if (entry.actions[idx]?.type === "clear") return idx;
    }
    return -1;
  }

  function syncCommitFromStorage(entry) {
    if (!entry.commitCtx || !entry.commitCanvas || !entry.storageCanvas) return;
    entry.commitCtx.save();
    entry.commitCtx.globalCompositeOperation = "copy";
    entry.commitCtx.drawImage(entry.storageCanvas, 0, 0, entry.commitCanvas.width, entry.commitCanvas.height);
    entry.commitCtx.restore();
  }

  function renderAllFromActions(entry) {
    if (!entry) return;
    if (!entry.storageCanvas || !entry.storageCtx) {
      const resized = ensureStorageCanvas(entry);
      if (resized && entry.storageCanvas && entry.storageCtx) {
        // continue with new canvas
      } else if (!entry.storageCanvas) {
        return;
      }
    }

    const ctx = entry.storageCtx;
    clearCanvas(ctx, entry.storageCanvas);

    const lastClearIdx = getLastClearIndex(entry);
    const startIdx = lastClearIdx >= 0 ? lastClearIdx + 1 : 0;

    if (lastClearIdx < 0 && entry.committedImageEl) {
      ctx.drawImage(entry.committedImageEl, 0, 0, entry.storageCanvas.width, entry.storageCanvas.height);
    }

    const hasBase = lastClearIdx < 0 && Boolean(entry.committedImageEl || entry.committedImage);
    for (let idx = startIdx; idx < entry.actions.length; idx += 1) {
      const action = entry.actions[idx];
      if (action?.type === "stroke" && action.stroke) {
        drawStrokeToContext(ctx, entry, action.stroke, { target: "storage" });
      }
    }

    entry.hasCommittedContent = hasBase ||
      entry.actions.slice(startIdx).some((action) => action?.type === "stroke");

    syncCommitFromStorage(entry);
  }

  function scheduleBaseImageRender(entry, dataUrl) {
    entry.committedImage = dataUrl || null;
    entry.committedImageEl = null;
    entry.committedImageToken += 1;
    const token = entry.committedImageToken;

    if (!dataUrl) {
      renderAllFromActions(entry);
      return;
    }

    loadImage(dataUrl)
      .then((img) => {
        if (entry.committedImageToken !== token) return;
        entry.committedImageEl = img;
        renderAllFromActions(entry);
      })
      .catch((err) => {
        console.warn("Annotation image load failed", err);
      });
  }

  function primeCommittedImage(pageNumber, payload) {
    const entry = ensureEntry(pageNumber);
    const dataUrl = payload?.dataUrl || null;
    if (Number.isFinite(payload?.pageWidth)) entry.pageWidth = payload.pageWidth;
    if (Number.isFinite(payload?.pageHeight)) entry.pageHeight = payload.pageHeight;
    entry.actions = [];
    entry.redo = [];
    entry.needsUpload = false;
    entry.overlayDirty = false;
    entry.overlayNeedsFullRedraw = true;
    entry.activePointers.clear();
    entry.hasCommittedContent = Boolean(dataUrl);
    ensureStorageCanvas(entry);
    scheduleBaseImageRender(entry, dataUrl);
  }

  function ensureOverlay(entry, frame) {
    if (entry.overlay && entry.overlay.isConnected && entry.overlay.parentElement === frame) {
      entry.overlayCtx = entry.overlay.getContext("2d");
      return entry.overlay;
    }

    const overlay = document.createElement("canvas");
    overlay.className = "annotation-layer";
    overlay.dataset.pageNumber = String(entry.pageNumber);
    overlay.addEventListener("pointerdown", (event) => handlePointerDown(event, entry), { passive: false });
    overlay.addEventListener("pointermove", (event) => handlePointerMove(event, entry), { passive: false });
    overlay.addEventListener("pointerup", (event) => handlePointerEnd(event, entry, true), { passive: false });
    overlay.addEventListener("pointercancel", (event) => handlePointerEnd(event, entry, true), { passive: false });
    overlay.addEventListener("pointerleave", (event) => handlePointerEnd(event, entry, true), { passive: false });
    overlay.addEventListener("contextmenu", (event) => event.preventDefault());
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

    ensureStorageCanvas(entry);
    try { entry.overlay.setPointerCapture(event.pointerId); } catch {}
    const point = getNormalizedPoint(event, entry);
    const stroke = createStroke(point, entry, event);
    entry.actions.push({ type: "stroke", stroke, ts: Date.now() });
    entry.redo = [];
    entry.activePointers.set(event.pointerId, stroke);
    lastActivePage = entry.pageNumber;
    scheduleOverlayRender(entry);
    entry.overlayDirty = true;
    entry.dirty = true;
    entry.needsUpload = true;
    lastInputTs = Date.now();
    event.stopPropagation();
    event.preventDefault();
  }

  function handlePointerMove(event, entry) {
    const stroke = entry.activePointers.get(event.pointerId);
    if (!stroke) return;
    const points = collectCoalescedPoints(event, entry);
    if (!points.length) {
      event.preventDefault();
      return;
    }
    let lastPoint = stroke.points[stroke.points.length - 1];
    points.forEach((point) => {
      if (!lastPoint) {
        stroke.points.push(point);
        lastPoint = point;
        return;
      }
      if (Math.abs(point.x - lastPoint.x) + Math.abs(point.y - lastPoint.y) < 0.0004) {
        return;
      }
      stroke.points.push(point);
      lastPoint = point;
    });
    scheduleOverlayRender(entry);
    entry.overlayDirty = true;
    entry.dirty = true;
    entry.needsUpload = true;
    lastInputTs = Date.now();
    event.stopPropagation();
    event.preventDefault();
  }

  function handlePointerEnd(event, entry, shouldQueue) {
    const stroke = entry.activePointers.get(event.pointerId);
    if (!stroke) return;
    entry.activePointers.delete(event.pointerId);
    try { entry.overlay?.releasePointerCapture(event.pointerId); } catch {}

    if (shouldQueue) {
      commitStroke(entry, stroke);
      queueSave(entry.pageNumber);
    } else {
      // Cancelled stroke
      entry.actions = entry.actions.filter((action) => action?.stroke !== stroke);
    }
    lastInputTs = Date.now();
    entry.overlayNeedsFullRedraw = true;
    scheduleOverlayRender(entry);
    entry.dirty = entry.actions.length > 0;
    event.stopPropagation();
    event.preventDefault();
  }

  function createStroke(startPoint, entry, event) {
    const cfg = TOOL_CONFIG[options.tool] || TOOL_CONFIG.pen;
    const displayWidth = Number(entry.displayWidth || 0) || 1;
    const storageWidth = Number(entry.storageWidth || 0) || displayWidth;
    const widthScale = storageWidth / Math.max(displayWidth, 1);
    return {
      tool: options.tool,
      color: options.color,
      size: Math.max(1, options.size),
      alpha: options.tool === "highlighter" ? options.highlightAlpha : 1,
      widthMultiplier: cfg.widthMultiplier || 1,
      points: [startPoint],
      widthScale,
      hasPressure: event?.pointerType === "pen",
      overlayDrawnIndex: 0,
      dotDrawn: false
    };
  }

  function getNormalizedPoint(event, entry) {
    const target = entry.frame || event.currentTarget;
    const rect = target.getBoundingClientRect();
    const nx = (event.clientX - rect.left) / Math.max(rect.width, 1);
    const ny = (event.clientY - rect.top) / Math.max(rect.height, 1);
    const pressure = event.pointerType === "pen"
      ? Math.max(0.05, Math.min(1, Number(event.pressure) || 0.5))
      : 0.8;
    return {
      x: Math.min(1, Math.max(0, nx)),
      y: Math.min(1, Math.max(0, ny)),
      p: pressure
    };
  }

  function collectCoalescedPoints(event, entry) {
    const events = typeof event.getCoalescedEvents === "function"
      ? event.getCoalescedEvents()
      : [event];
    const list = events && events.length ? events : [event];
    return list.map((evt) => getNormalizedPoint(evt, entry));
  }

  function toCanvasPoint(point, width, height) {
    return {
      x: point.x * width,
      y: point.y * height
    };
  }

  function computePressureScale(stroke, pressure) {
    if (!stroke?.hasPressure) return 1;
    const p = Math.max(0.05, Math.min(1, Number(pressure) || 0.5));
    return 0.45 + p * 0.85;
  }

  function applyStrokeBaseStyle(ctx, stroke) {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }

  function drawStrokeToContext(ctx, entry, stroke, { target = "overlay", startIndex = 1 } = {}) {
    if (!ctx || !stroke || !stroke.points?.length) return;
    const canvas = target === "overlay" ? entry.overlay : entry.storageCanvas;
    if (!canvas) return;
    const width = canvas.width || 1;
    const height = canvas.height || 1;
    const ratio = target === "overlay" ? (entry.pixelRatio || 1) : (stroke.widthScale || 1);
    const baseWidth = Math.max(0.5, stroke.size * (stroke.widthMultiplier || 1) * ratio);

    ctx.save();
    applyStrokeBaseStyle(ctx, stroke);

    const points = stroke.points;
    if (points.length === 1) {
      if (!stroke.dotDrawn || target !== "overlay") {
        const p = toCanvasPoint(points[0], width, height);
        ctx.globalAlpha = stroke.alpha ?? 1;
        ctx.lineWidth = baseWidth * computePressureScale(stroke, points[0].p);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + 0.02, p.y + 0.02);
        ctx.stroke();
        stroke.dotDrawn = true;
      }
      ctx.restore();
      return;
    }

    const start = Math.max(1, startIndex);
    for (let idx = start; idx < points.length; idx += 1) {
      const prev = toCanvasPoint(points[idx - 1], width, height);
      const curr = toCanvasPoint(points[idx], width, height);
      const pressure = points[idx]?.p ?? points[idx - 1]?.p;
      ctx.globalAlpha = stroke.alpha ?? 1;
      ctx.lineWidth = baseWidth * computePressureScale(stroke, pressure);
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(curr.x, curr.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function scheduleOverlayRender(entry) {
    if (!entry) return;
    entry.overlayDirty = true;
    if (scheduleOverlayRender.raf) return;
    scheduleOverlayRender.raf = window.requestAnimationFrame(() => {
      scheduleOverlayRender.raf = null;
      pages.forEach((pageEntry) => {
        if (pageEntry.overlayDirty) {
          renderOverlayFrame(pageEntry);
        }
      });
    });
  }
  scheduleOverlayRender.raf = null;

  function renderOverlayFrame(entry) {
    if (!entry.overlayCtx || !entry.overlay) return;

    if (entry.overlayNeedsFullRedraw) {
      entry.overlayCtx.clearRect(0, 0, entry.overlay.width, entry.overlay.height);
      entry.activePointers.forEach((stroke) => {
        stroke.overlayDrawnIndex = 0;
        drawStrokeToContext(entry.overlayCtx, entry, stroke, { target: "overlay", startIndex: 1 });
        stroke.overlayDrawnIndex = stroke.points.length - 1;
      });
      entry.overlayNeedsFullRedraw = false;
      entry.overlayDirty = false;
      return;
    }

    entry.activePointers.forEach((stroke) => {
      const lastDrawn = Number.isInteger(stroke.overlayDrawnIndex) ? stroke.overlayDrawnIndex : 0;
      const startIndex = Math.max(1, lastDrawn + 1);
      if (stroke.points.length <= startIndex) return;
      drawStrokeToContext(entry.overlayCtx, entry, stroke, { target: "overlay", startIndex });
      stroke.overlayDrawnIndex = stroke.points.length - 1;
    });

    entry.overlayDirty = false;
  }

  function redrawOverlay(entry) {
    if (!entry || !entry.overlayCtx || !entry.overlay) return;
    entry.overlayCtx.clearRect(0, 0, entry.overlay.width, entry.overlay.height);
    entry.activePointers.forEach((stroke) => {
      stroke.overlayDrawnIndex = 0;
      stroke.dotDrawn = false;
      drawStrokeToContext(entry.overlayCtx, entry, stroke, { target: "overlay", startIndex: 1 });
      stroke.overlayDrawnIndex = stroke.points.length - 1;
    });
    entry.overlayDirty = false;
  }

  function commitStroke(entry, stroke) {
    if (!entry || !stroke) return;
    ensureStorageCanvas(entry);
    if (entry.storageCtx && entry.storageCanvas) {
      drawStrokeToContext(entry.storageCtx, entry, stroke, { target: "storage", startIndex: 1 });
      entry.hasCommittedContent = true;
      syncCommitFromStorage(entry);
    }
  }

  function finalizeActiveStrokes() {
    pages.forEach((entry) => {
      if (!entry.activePointers || entry.activePointers.size === 0) return;
      entry.activePointers.forEach((stroke) => {
        commitStroke(entry, stroke);
      });
      entry.activePointers.clear();
      entry.overlayNeedsFullRedraw = true;
      entry.overlayDirty = false;
      entry.dirty = entry.actions.length > 0;
      entry.needsUpload = true;
      pendingPages.add(entry.pageNumber);
      if (!pendingSince) pendingSince = Date.now();
      redrawOverlay(entry);
    });
  }

  function hasActivePointers() {
    for (const entry of pages.values()) {
      if (entry.activePointers && entry.activePointers.size) return true;
    }
    return false;
  }

  function queueSave(pageNumber, opts = {}) {
    if (!fileName) return;
    const entry = pages.get(pageNumber);
    if (entry) entry.needsUpload = true;
    pendingPages.add(pageNumber);
    if (!pendingSince) pendingSince = Date.now();
    if (opts.immediate) {
      void flushSaves({ force: true });
      return;
    }
    scheduleIdleFlush();
  }

  function scheduleIdleFlush() {
    if (saveTimer) return;
    saveTimer = window.setTimeout(checkIdleFlush, IDLE_SAVE_DELAY);
  }

  function checkIdleFlush() {
    saveTimer = null;
    if (saving || !fileName) return;
    if (!pendingPages.size) return;
    const now = Date.now();
    const idle = now - lastInputTs >= IDLE_SAVE_DELAY;
    const noActive = !hasActivePointers();
    const age = pendingSince ? now - pendingSince : 0;
    if (noActive && (idle || age >= MAX_PENDING_AGE)) {
      void flushSaves();
    } else {
      scheduleIdleFlush();
    }
  }

  function serializeCanvasIdle(canvas) {
    if (!canvas) return Promise.resolve(null);
    return new Promise((resolve) => {
      const run = () => {
        try {
          resolve(serializeCanvasPngLimited(canvas));
        } catch (err) {
          console.warn("Annotation serialization failed", err);
          resolve(null);
        }
      };
      if (typeof window.requestIdleCallback === "function") {
        idleCallback = window.requestIdleCallback(() => {
          idleCallback = null;
          run();
        }, { timeout: 800 });
      } else {
        window.setTimeout(run, 0);
      }
    });
  }

  async function flushSaves(opts = {}) {
    if (saving || !fileName) return;
    if (!pendingPages.size) return;
    if (!opts.force && hasActivePointers()) return;

    const items = [];
    const retryPages = new Set();
    for (const pageNumber of Array.from(pendingPages)) {
      const entry = pages.get(pageNumber);
      if (!entry) continue;
      if (!entry.needsUpload) continue;

      ensureStorageCanvas(entry);
      let dataUrl = null;
      if (entry.hasCommittedContent && entry.storageCanvas) {
        dataUrl = await serializeCanvasIdle(entry.storageCanvas);
      }

      if (entry.hasCommittedContent && !dataUrl) {
        entry.needsUpload = true;
        retryPages.add(entry.pageNumber);
        continue;
      }

      entry.needsUpload = false;
      items.push({ entry, payload: {
        pageNumber,
        dataUrl,
        pageWidth: entry.pageWidth,
        pageHeight: entry.pageHeight
      }});
    }

    pendingPages.clear();
    retryPages.forEach((page) => pendingPages.add(page));
    pendingSince = pendingPages.size ? Date.now() : null;
    if (!items.length) {
      if (pendingPages.size) scheduleIdleFlush();
      return;
    }

    saving = true;
    let didShowSaving = false;
    items.forEach(({ entry }) => markSaving(entry, true));
    if (saveStatusTimer) {
      clearTimeout(saveStatusTimer);
    }
    saveStatusTimer = window.setTimeout(() => {
      didShowSaving = true;
      showStatus("Notizen speichern…");
    }, SAVE_STATUS_DELAY);

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

      if (didShowSaving) {
        showStatus("Notizen gespeichert", 1600);
      }
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
      if (saveStatusTimer) {
        clearTimeout(saveStatusTimer);
        saveStatusTimer = null;
      }
      items.forEach(({ entry }) => markSaving(entry, false));
      saving = false;
      if (pendingPages.size) scheduleIdleFlush();
    }
  }

  function markSaving(entry, flag) {
    if (!entry.overlay) return;
    entry.overlay.classList.toggle("is-saving", flag);
  }

  async function undoLastStroke() {
    if (undoPendingStroke()) return;
    await undoPreviousVersion();
  }

  function undoPendingStroke() {
    const pageOrder = lastActivePage ? [lastActivePage, ...Array.from(pages.keys()).filter((n) => n !== lastActivePage).reverse()] : Array.from(pages.keys()).reverse();
    for (const pageNumber of pageOrder) {
      const entry = pages.get(pageNumber);
      if (!entry || !entry.actions.length) continue;
      const action = entry.actions.pop();
      if (action) entry.redo.push(action);
      entry.dirty = entry.actions.length > 0;
      entry.needsUpload = true;
      entry.overlayNeedsFullRedraw = true;
      entry.activePointers.clear();
      renderAllFromActions(entry);
      redrawOverlay(entry);
      queueSave(pageNumber);
      const message = action?.type === "clear" ? "Leeren rückgängig" : "Notiz entfernt";
      showStatus(message, 1200);
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
      pendingSince = null;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (idleCallback && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleCallback);
        idleCallback = null;
      }

      pages.forEach((entry, pageNumber) => {
        entry.actions = [];
        entry.redo = [];
        entry.activePointers.clear();
        entry.dirty = false;
        entry.overlayDirty = false;
        entry.overlayNeedsFullRedraw = true;
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
    const hasOverlayContent = entry.activePointers && entry.activePointers.size > 0;
    const hasVisibleContent = entry.hasCommittedContent || hasOverlayContent;

    if (!hasVisibleContent) {
      showStatus("Keine Notizen vorhanden", 1200);
      return;
    }

    entry.actions.push({ type: "clear", ts: Date.now() });
    entry.redo = [];
    entry.activePointers.clear();
    entry.overlayNeedsFullRedraw = true;
    entry.dirty = true;
    entry.needsUpload = true;

    renderAllFromActions(entry);
    redrawOverlay(entry);

    queueSave(entry.pageNumber);
    showStatus("Seite geleert", 1600);
  }

  function setActiveState(next, opts = {}) {
    const changed = opts.force ? true : next !== active;
    // console.log('[Annotation] setActiveState called - next:', next, 'current active:', active, 'changed:', changed, 'opts:', opts);
    if (!changed) return;
    active = next;
    document.body.classList.toggle("annotations-active", active);
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
    isActive: () => active,
    isDrawing: () => hasActivePointers(),
    flushSaves: (opts = {}) => flushSaves(opts),
    clearRedo: () => {
      pages.forEach((entry) => { entry.redo = []; });
    }
  };

  Object.defineProperty(api, "primeCommittedImage", {
    value: (pageNumber, payload) => primeCommittedImage(pageNumber, payload),
    enumerable: true
  });

  return api;
}
