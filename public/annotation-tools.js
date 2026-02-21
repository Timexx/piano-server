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
  highlighter: { widthMultiplier: 2.4, alpha: 0.35 },
  eraser: { widthMultiplier: 0, alpha: 0 }
};

const INPUT_MODES = {
  PEN_ONLY: "pen-only",
  BOTH: "both"
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

  const MAX_UPLOAD_BYTES = 9 * 1024 * 1024;
  const MAX_COMPRESSION_ATTEMPTS = 3;
  const STORAGE_SCALE = 2;
  const MAX_STORAGE_DIM = 4096;
  const IDLE_SAVE_DELAY = 1200;
  const MAX_PENDING_AGE = 5000;
  const SAVE_STATUS_DELAY = 2000;
  const MAX_HISTORY = 20;
  const ERASER_RADIUS_NORM = 0.035;

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
    clearBtn: null,
    presetApplyBtn: null,
    presetSaveBtn: null,
    inputPenBtn: null,
    inputBothBtn: null,
    statusLine: null,
    pencilBadge: null
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
  let inputMode = INPUT_MODES.PEN_ONLY;
  let savedPreset = null;
  let serverUndoAvailable = false;
  let lastActionLabel = "";
  let statusOverride = null;
  let pencilActive = false;
  let pencilTimer = null;
  let penInputActive = false;
  const penPointerIds = new Set();

  function initControls() {
    if (controls.initialized) return;

    controls.root = document.getElementById("annotationControls");
    if (!controls.root) return;

    controls.toggle = document.getElementById("btnAnnotationToggle");
    controls.panel = document.getElementById("annotationPanel");
    controls.toolbar = document.getElementById("annotationToolbar");
    if (controls.toolbar && !controls.toolbar.dataset.detachedToBody) {
      document.body.appendChild(controls.toolbar);
      controls.toolbar.dataset.detachedToBody = "1";
    }

    if (controls.toolbar) {
      const dragHandle = controls.toolbar.querySelector('.annotation-toolbar-drag-handle');
      if (dragHandle) {
        let isDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let toolbarStartX = 0;
        let toolbarStartY = 0;

        const getToolbarPos = () => {
          const rect = controls.toolbar.getBoundingClientRect();
          return { x: rect.left, y: rect.top };
        };

        const applyPosition = (x, y) => {
          const tw = controls.toolbar.offsetWidth;
          const th = controls.toolbar.offsetHeight;
          const maxX = window.innerWidth - tw;
          const maxY = window.innerHeight - th;
          const clampedX = Math.max(0, Math.min(x, maxX));
          const clampedY = Math.max(0, Math.min(y, maxY));
          controls.toolbar.style.left = `${clampedX}px`;
          controls.toolbar.style.top = `${clampedY}px`;
          controls.toolbar.style.bottom = 'auto';
          controls.toolbar.style.transform = 'none';
          try { localStorage.setItem('annotation-toolbar-pos', JSON.stringify({ x: clampedX, y: clampedY })); } catch {}
        };

        try {
          const saved = JSON.parse(localStorage.getItem('annotation-toolbar-pos'));
          if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
            applyPosition(saved.x, saved.y);
          }
        } catch {}

        dragHandle.addEventListener('pointerdown', (e) => {
          isDragging = true;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          const pos = getToolbarPos();
          toolbarStartX = pos.x;
          toolbarStartY = pos.y;
          dragHandle.setPointerCapture(e.pointerId);
          e.preventDefault();
          e.stopPropagation();
        });

        dragHandle.addEventListener('pointermove', (e) => {
          if (!isDragging) return;
          const dx = e.clientX - dragStartX;
          const dy = e.clientY - dragStartY;
          applyPosition(toolbarStartX + dx, toolbarStartY + dy);
        });

        dragHandle.addEventListener('pointerup', () => { isDragging = false; });
        dragHandle.addEventListener('pointercancel', () => { isDragging = false; });
      }

      const moreBtn = document.getElementById('btnAnnotationMore');
      const secondaryRow = document.getElementById('annotationSecondaryRow');
      if (moreBtn && secondaryRow) {
        moreBtn.addEventListener('click', () => {
          const visible = secondaryRow.style.display !== 'none';
          secondaryRow.style.display = visible ? 'none' : 'flex';
          moreBtn.setAttribute('aria-expanded', String(!visible));
        });
      }
    }

    controls.sizeInput = document.getElementById("annotationSize");
    controls.sizeValue = document.getElementById("annotationSizeValue");
    controls.undoBtn = document.getElementById("btnAnnotationUndo");
    controls.clearBtn = document.getElementById("btnAnnotationClear");
    controls.presetApplyBtn = document.getElementById("btnAnnotationPresetApply");
    controls.presetSaveBtn = document.getElementById("btnAnnotationPresetSave");
    controls.inputPenBtn = document.getElementById("btnAnnotationInputPenOnly");
    controls.inputBothBtn = document.getElementById("btnAnnotationInputBoth");
    controls.statusLine = document.getElementById("annotationStatusLine");
    controls.pencilBadge = document.getElementById("annotationPencilBadge");

    if (controls.toolbar) {
      controls.toolbar.setAttribute("aria-hidden", controls.toolbar.classList.contains("hidden") ? "true" : "false");
    }

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
      controls.toggle.addEventListener("click", () => {
        setActiveState(!active);
      });
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
    updateInputModeButtons();
    updatePresetButtons();
    updateUndoState();
    updateStatusLine();
    setPencilActive(false);

    controls.initialized = true;
  }

  function enterViewer({ fileName: nextFile }) {
    finalizeActiveStrokes();
    void flushSaves({ force: true });
    resetPages();
    fileName = nextFile || null;
    lastActivePage = null;
    serverUndoAvailable = false;
    lastActionLabel = "";
    statusOverride = null;
    clearPenPointers();
    setActiveState(false, { silent: true, force: true });
    updateToggleUI();
    refreshOverlayActivation();
    clearStatusTimer();
    updateUndoState();
    updateStatusLine();
  }

  function leaveViewer() {
    finalizeActiveStrokes();
    void flushSaves({ force: true });
    setActiveState(false, { silent: true, force: true });
    fileName = null;
    clearPenPointers();
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
    clearPenPointers();
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

    const resized = ensureStorageCanvas(entry);

    if (resized && entry.pendingBaseImageUrl !== undefined && entry.pendingBaseImageUrl !== null) {
      const url = entry.pendingBaseImageUrl;
      entry.pendingBaseImageUrl = null;
      applyBaseImage(entry, url);
    } else if (resized && entry.hasContent) {
      // Canvas was recreated but no pending image — content is lost
      entry.hasContent = false;
    }

    syncCommitFromStorage(entry);
    redrawOverlay(entry);
    refreshOverlayActivationForEntry(entry);

    if (committed && committed.dataset.zoomPreviewHidden) {
      delete committed.dataset.zoomPreviewHidden;
      committed.style.opacity = '';
    }
    if (overlay && overlay.dataset.zoomPreviewHidden) {
      delete overlay.dataset.zoomPreviewHidden;
      overlay.style.opacity = '';
    }
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
    if (isActive) {
      const eraserSelected = options.tool === 'eraser';
      entry.overlay.style.touchAction = (eraserSelected || inputMode === INPUT_MODES.BOTH || penInputActive) ? "none" : "pan-x pan-y";
      entry.overlay.dataset.tool = options.tool || "pen";
    } else {
      entry.overlay.style.touchAction = "auto";
      delete entry.overlay.dataset.tool;
    }
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
        activePointers: new Map(),
        // ImageData snapshot-based undo
        history: [],            // ImageData[] — state before each operation, max MAX_HISTORY
        redoStack: [],          // ImageData[] — for redo
        hasContent: false,      // true when storageCanvas has visible pixels
        pendingBaseImageUrl: null, // deferred base image, applied once canvas is ready
        dirty: false,
        overlayDirty: false,
        overlayNeedsFullRedraw: false,
        needsUpload: false
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

  function syncCommitFromStorage(entry) {
    if (!entry.commitCtx || !entry.commitCanvas || !entry.storageCanvas) return;
    entry.commitCtx.save();
    entry.commitCtx.globalCompositeOperation = "copy";
    entry.commitCtx.drawImage(entry.storageCanvas, 0, 0, entry.commitCanvas.width, entry.commitCanvas.height);
    entry.commitCtx.restore();
  }

  // ===== Snapshot-based undo =====

  function imageDataHasContent(imageData) {
    if (!imageData) return false;
    const data = imageData.data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true;
    }
    return false;
  }

  // Snapshot current storageCanvas state onto history stack before a new operation.
  // Also clears redoStack since a new operation invalidates any pending redo.
  function pushHistory(entry) {
    if (!entry.storageCanvas || !entry.storageCtx) return;
    try {
      const snapshot = entry.storageCtx.getImageData(
        0, 0, entry.storageCanvas.width, entry.storageCanvas.height
      );
      entry.history.push(snapshot);
      if (entry.history.length > MAX_HISTORY) entry.history.shift();
      entry.redoStack = [];
    } catch {
      // Tainted canvas — skip
    }
  }

  // Draw a server-supplied base image onto the storageCanvas.
  // Clears existing content, resets history (loaded state is the new baseline).
  function applyBaseImage(entry, dataUrl) {
    if (!dataUrl) {
      clearCanvas(entry.storageCtx, entry.storageCanvas);
      entry.hasContent = false;
      entry.history = [];
      entry.redoStack = [];
      syncCommitFromStorage(entry);
      redrawOverlay(entry);
      return;
    }
    loadImage(dataUrl)
      .then((img) => {
        if (!entry.storageCanvas || !entry.storageCtx) return;
        clearCanvas(entry.storageCtx, entry.storageCanvas);
        entry.storageCtx.drawImage(img, 0, 0, entry.storageCanvas.width, entry.storageCanvas.height);
        entry.hasContent = true;
        entry.history = [];
        entry.redoStack = [];
        syncCommitFromStorage(entry);
        redrawOverlay(entry);
      })
      .catch((err) => console.warn("Annotation image load failed", err));
  }

  function primeCommittedImage(pageNumber, payload) {
    const entry = ensureEntry(pageNumber);
    const dataUrl = payload?.dataUrl || null;
    if (Number.isFinite(payload?.pageWidth)) entry.pageWidth = payload.pageWidth;
    if (Number.isFinite(payload?.pageHeight)) entry.pageHeight = payload.pageHeight;

    entry.needsUpload = false;
    entry.overlayDirty = false;
    entry.overlayNeedsFullRedraw = true;
    entry.activePointers.clear();
    entry.history = [];
    entry.redoStack = [];
    entry.hasContent = Boolean(dataUrl);

    ensureStorageCanvas(entry);

    if (entry.storageCanvas) {
      applyBaseImage(entry, dataUrl);
    } else {
      // Defer until attachPageLayer creates the canvas
      entry.pendingBaseImageUrl = dataUrl;
    }

    updateUndoState();
    updateStatusLine();
  }

  function ensureOverlay(entry, frame) {
    if (entry.overlay && entry.overlay.isConnected && entry.overlay.parentElement === frame) {
      entry.overlayCtx = entry.overlay.getContext("2d");
      return entry.overlay;
    }

    const overlay = document.createElement("canvas");
    overlay.className = "annotation-layer";
    overlay.dataset.pageNumber = String(entry.pageNumber);
    overlay.addEventListener("touchstart", handleTouchGuard, { passive: false });
    overlay.addEventListener("touchmove", handleTouchGuard, { passive: false });
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
      const safeRatio = Math.min(0.95, shrinkRatio);
      const scaled = scaleCanvas(current, safeRatio);
      current = scaled;
      dataUrl = current.toDataURL("image/png");
      sizeBytes = estimateBase64Size(dataUrl);
    }

    return dataUrl;
  }

  function isStylusEvent(event) {
    if (event.pointerType === "pen") return true;
    if (event.pointerType !== "touch") return false;
    if (Number.isFinite(event.tiltX) && Math.abs(event.tiltX) > 0) return true;
    if (Number.isFinite(event.tiltY) && Math.abs(event.tiltY) > 0) return true;
    const w = Number(event.width) || 0;
    const h = Number(event.height) || 0;
    const maxDim = Math.max(w, h);
    return maxDim > 0 && maxDim <= 8;
  }

  function isStylusTouch(touch) {
    if (!touch) return false;
    const touchType = touch.touchType;
    if (touchType && touchType !== "direct") return true;
    const radiusX = Number(touch.radiusX) || 0;
    const radiusY = Number(touch.radiusY) || 0;
    const maxRadius = Math.max(radiusX, radiusY);
    return maxRadius > 0 && maxRadius <= 6;
  }

  function shouldBlockTouch(event) {
    if (!active || !fileName) return false;
    if (inputMode === INPUT_MODES.BOTH) return true;
    const touches = event.touches && event.touches.length ? event.touches : event.changedTouches;
    if (!touches) return false;
    for (const touch of touches) {
      if (isStylusTouch(touch)) return true;
    }
    return false;
  }

  function handleTouchGuard(event) {
    if (!shouldBlockTouch(event)) return;
    event.preventDefault();
  }

  function registerPenPointer(event) {
    if (!isStylusEvent(event)) return;
    penPointerIds.add(event.pointerId);
    if (!penInputActive) {
      penInputActive = true;
      refreshOverlayActivation();
    }
  }

  function releasePenPointer(event) {
    if (!penPointerIds.has(event.pointerId)) return;
    penPointerIds.delete(event.pointerId);
    if (penPointerIds.size === 0 && penInputActive) {
      penInputActive = false;
      refreshOverlayActivation();
    }
  }

  function clearPenPointers() {
    penPointerIds.clear();
    if (penInputActive) {
      penInputActive = false;
      refreshOverlayActivation();
    }
  }

  function shouldHandlePointer(event) {
    if (!active || !fileName) return false;
    if (inputMode === INPUT_MODES.BOTH) return true;
    return isStylusEvent(event);
  }

  // ===== Pointer handlers =====

  function handlePointerDown(event, entry) {
    if (!active || !fileName) return;
    // Eraser responds to all pointer types (finger touch included)
    if (options.tool === 'eraser') {
      handleEraserPointerDown(event, entry);
      return;
    }
    if (!shouldHandlePointer(event)) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!entry.overlay) return;
    if (isStylusEvent(event)) markPencilActive();

    registerPenPointer(event);
    ensureStorageCanvas(entry);
    // Snapshot before drawing so this stroke can be undone
    pushHistory(entry);

    try { entry.overlay.setPointerCapture(event.pointerId); } catch {}
    const point = getNormalizedPoint(event, entry);
    const stroke = createStroke(point, entry, event);
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
    if (!active || !fileName) return;
    if (options.tool === 'eraser') {
      handleEraserPointerMove(event, entry);
      return;
    }
    if (!shouldHandlePointer(event)) return;
    if (isStylusEvent(event)) markPencilActive();

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

  function handlePointerEnd(event, entry, shouldCommit) {
    if (!active || !fileName) {
      releasePenPointer(event);
      return;
    }
    if (options.tool === 'eraser') {
      handleEraserPointerEnd(event, entry);
      return;
    }
    if (!shouldHandlePointer(event)) {
      releasePenPointer(event);
      return;
    }
    if (isStylusEvent(event)) markPencilActive();

    releasePenPointer(event);
    const stroke = entry.activePointers.get(event.pointerId);
    if (!stroke) return;
    entry.activePointers.delete(event.pointerId);
    try { entry.overlay?.releasePointerCapture(event.pointerId); } catch {}

    if (shouldCommit) {
      commitStroke(entry, stroke);
      queueSave(entry.pageNumber);
      setLastAction("Strich");
    } else {
      // Cancelled — restore pre-stroke snapshot
      const snapshot = entry.history.pop();
      if (snapshot && entry.storageCanvas && entry.storageCtx) {
        try { entry.storageCtx.putImageData(snapshot, 0, 0); } catch {}
        syncCommitFromStorage(entry);
      }
    }
    updateUndoState();
    lastInputTs = Date.now();
    entry.overlayNeedsFullRedraw = true;
    scheduleOverlayRender(entry);
    entry.dirty = entry.hasContent;
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

  // ===== Pixel-based eraser =====

  function handleEraserPointerDown(event, entry) {
    if (!active || !fileName) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!entry.overlay) return;

    registerPenPointer(event);
    ensureStorageCanvas(entry);
    // Snapshot before the erase gesture so the whole gesture is one undo step
    pushHistory(entry);

    try { entry.overlay.setPointerCapture(event.pointerId); } catch {}
    const point = getNormalizedPoint(event, entry);
    entry.activePointers.set(event.pointerId, { eraser: true, lastPoint: point });
    lastActivePage = entry.pageNumber;

    // Hide commitCanvas so only the overlay shows content during the gesture.
    // The overlay is the proven live-rendering surface (same as pen strokes).
    if (entry.commitCanvas) entry.commitCanvas.style.visibility = 'hidden';

    // Erase from ground-truth storageCanvas
    eraseCircleNormalized(entry, point.x, point.y);

    // Schedule rendering through the SAME rAF pipeline that makes pen strokes live
    entry.overlayNeedsFullRedraw = true;
    entry.overlayDirty = true;
    scheduleOverlayRender(entry);

    lastInputTs = Date.now();
    entry.dirty = true;
    entry.needsUpload = true;
    event.stopPropagation();
    event.preventDefault();
  }

  function handleEraserPointerMove(event, entry) {
    if (!active || !fileName) return;
    const data = entry.activePointers.get(event.pointerId);
    if (!data || !data.eraser) return;

    const points = collectCoalescedPoints(event, entry);
    points.forEach((point) => eraseCircleNormalized(entry, point.x, point.y));

    const last = points[points.length - 1];
    if (last) data.lastPoint = last;

    // Schedule rendering through the SAME rAF pipeline that makes pen strokes live
    entry.overlayNeedsFullRedraw = true;
    entry.overlayDirty = true;
    scheduleOverlayRender(entry);

    lastInputTs = Date.now();
    entry.dirty = true;
    entry.needsUpload = true;
    event.stopPropagation();
    event.preventDefault();
  }

  function handleEraserPointerEnd(event, entry) {
    releasePenPointer(event);
    const data = entry.activePointers.get(event.pointerId);
    if (!data || !data.eraser) return;
    entry.activePointers.delete(event.pointerId);
    try { entry.overlay?.releasePointerCapture(event.pointerId); } catch {}

    // Once all eraser pointers lifted, finish the gesture
    const remainingErasers = Array.from(entry.activePointers.values()).some((d) => d.eraser);
    if (remainingErasers) {
      event.stopPropagation();
      event.preventDefault();
      return;
    }

    // Show commitCanvas again and sync the erased storageCanvas into it
    syncCommitFromStorage(entry);
    if (entry.commitCanvas) entry.commitCanvas.style.visibility = '';

    // Clear overlay (commitCanvas is now showing the correct state)
    if (entry.overlay && entry.overlayCtx) {
      entry.overlayCtx.clearRect(0, 0, entry.overlay.width, entry.overlay.height);
    }
    entry.overlayDirty = false;

    // Check remaining content
    if (entry.storageCanvas && entry.storageCtx) {
      try {
        const imgData = entry.storageCtx.getImageData(
          0, 0, entry.storageCanvas.width, entry.storageCanvas.height
        );
        entry.hasContent = imageDataHasContent(imgData);
      } catch {
        entry.hasContent = true;
      }
    }

    queueSave(entry.pageNumber);
    setLastAction("Radiert");
    updateUndoState();
    showStatus("Notiz radiert", 600);
    event.stopPropagation();
    event.preventDefault();
  }

  // Erase a circle from storageCanvas at normalised coords (nx, ny)
  function eraseCircleNormalized(entry, nx, ny) {
    if (!entry.storageCanvas || !entry.storageCtx) return;
    const ctx = entry.storageCtx;
    const w = entry.storageCanvas.width;
    const h = entry.storageCanvas.height;
    const sizeScale = Math.max(0.3, options.size / 3);
    const r = ERASER_RADIUS_NORM * w * sizeScale;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(nx * w, ny * h, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fill();
    ctx.restore();
  }

  // Paint the eraser cursor circle onto a context at normalised coords
  function drawEraserCursorAt(ctx, w, h, nx, ny) {
    const sizeScale = Math.max(0.3, options.size / 3);
    const r = Math.max(8, ERASER_RADIUS_NORM * w * sizeScale);
    const x = nx * w;
    const y = ny * h;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 80, 80, 0.9)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - r * 0.55, y - r * 0.55);
    ctx.lineTo(x + r * 0.55, y + r * 0.55);
    ctx.moveTo(x + r * 0.55, y - r * 0.55);
    ctx.lineTo(x - r * 0.55, y + r * 0.55);
    ctx.strokeStyle = 'rgba(255, 80, 80, 0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // ===== End Eraser =====

  function toCanvasPoint(point, width, height) {
    return { x: point.x * width, y: point.y * height };
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
        if (pageEntry.overlayDirty) renderOverlayFrame(pageEntry);
      });
    });
  }
  scheduleOverlayRender.raf = null;

  function renderOverlayFrame(entry) {
    if (!entry.overlayCtx || !entry.overlay) return;
    const ctx = entry.overlayCtx;
    const canvas = entry.overlay;

    // Check if there is an active eraser gesture
    const hasActiveEraser = Array.from(entry.activePointers.values()).some((d) => d && d.eraser);

    if (hasActiveEraser) {
      // Eraser live rendering: paint the entire current storageCanvas onto the
      // overlay, then draw the cursor. Because commitCanvas is hidden during
      // the gesture, this overlay IS the user's live view — same rAF pipeline
      // that makes pen strokes work.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (entry.storageCanvas) {
        ctx.drawImage(entry.storageCanvas, 0, 0, canvas.width, canvas.height);
      }
      // Draw eraser cursor for each active eraser pointer
      entry.activePointers.forEach((data) => {
        if (data && data.eraser && data.lastPoint) {
          drawEraserCursorAt(ctx, canvas.width, canvas.height, data.lastPoint.x, data.lastPoint.y);
        }
      });
      entry.overlayNeedsFullRedraw = false;
      entry.overlayDirty = false;
      return;
    }

    // Normal pen-stroke overlay rendering
    if (entry.overlayNeedsFullRedraw) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      entry.activePointers.forEach((stroke) => {
        if (!stroke?.points?.length) return;
        stroke.overlayDrawnIndex = 0;
        drawStrokeToContext(ctx, entry, stroke, { target: "overlay", startIndex: 1 });
        stroke.overlayDrawnIndex = stroke.points.length - 1;
      });
      entry.overlayNeedsFullRedraw = false;
      entry.overlayDirty = false;
      return;
    }

    entry.activePointers.forEach((stroke) => {
      if (!stroke?.points?.length) return;
      const lastDrawn = Number.isInteger(stroke.overlayDrawnIndex) ? stroke.overlayDrawnIndex : 0;
      const startIndex = Math.max(1, lastDrawn + 1);
      if (stroke.points.length <= startIndex) return;
      drawStrokeToContext(ctx, entry, stroke, { target: "overlay", startIndex });
      stroke.overlayDrawnIndex = stroke.points.length - 1;
    });

    entry.overlayDirty = false;
  }

  function redrawOverlay(entry) {
    if (!entry || !entry.overlayCtx || !entry.overlay) return;
    entry.overlayCtx.clearRect(0, 0, entry.overlay.width, entry.overlay.height);
    entry.activePointers.forEach((stroke) => {
      if (!stroke?.points?.length) return;
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
      entry.hasContent = true;
      syncCommitFromStorage(entry);
    }
  }

  function finalizeActiveStrokes() {
    pages.forEach((entry) => {
      if (!entry.activePointers || entry.activePointers.size === 0) return;
      entry.activePointers.forEach((data) => {
        if (!data?.points?.length) return;
        commitStroke(entry, data);
      });
      entry.activePointers.clear();
      entry.overlayNeedsFullRedraw = true;
      entry.overlayDirty = false;
      entry.dirty = entry.hasContent;
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
      if (entry.hasContent && entry.storageCanvas) {
        dataUrl = await serializeCanvasIdle(entry.storageCanvas);
      }

      if (entry.hasContent && !dataUrl) {
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
    if (saveStatusTimer) clearTimeout(saveStatusTimer);
    saveStatusTimer = window.setTimeout(() => {
      didShowSaving = true;
      showStatus("Speichern\u2026");
    }, SAVE_STATUS_DELAY);

    try {
      const overlaysPayload = items.map((item) => item.payload);
      const bodyStr = JSON.stringify({ name: fileName, overlays: overlaysPayload });
      const isDeleteOnly = overlaysPayload.every((p) => !p.dataUrl);
      const useKeepalive = isDeleteOnly && bodyStr.length < 60 * 1024;
      const response = await (fetcher || window.fetch)("/api/annotations/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyStr,
        cache: "no-store",
        ...(useKeepalive ? { keepalive: true } : {})
      });

      if (!response.ok) {
        let serverMessage = null;
        try {
          const payload = await response.json();
          if (payload && typeof payload.error === "string") serverMessage = payload.error;
        } catch {}
        const err = new Error(serverMessage || `HTTP ${response.status}`);
        err.status = response.status;
        err.userMessage = serverMessage;
        throw err;
      }

      let result = null;
      try { result = await response.json(); } catch {}

      if (didShowSaving) showStatus();

      if (result && typeof result.historyRemaining === 'number') {
        serverUndoAvailable = result.historyRemaining > 0;
        updateUndoState();
      }

      if (typeof onSaved === "function") {
        const changedPages = Array.from(new Set(
          items.map(({ payload }) => payload.pageNumber)
            .filter((page) => Number.isInteger(page) && page > 0)
        ));
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
      showStatus(message, 2000, { toast: true });
      items.forEach(({ entry }) => { pendingPages.add(entry.pageNumber); });
    } finally {
      if (saveStatusTimer) { clearTimeout(saveStatusTimer); saveStatusTimer = null; }
      items.forEach(({ entry }) => markSaving(entry, false));
      saving = false;
      if (pendingPages.size) scheduleIdleFlush();
    }
  }

  function markSaving(entry, flag) {
    if (!entry.overlay) return;
    entry.overlay.classList.toggle("is-saving", flag);
  }

  let undoInProgress = false;

  async function undoLastStroke() {
    if (undoInProgress) return;
    if (!canUndo()) {
      showStatus("Nichts zum R\u00FCckg\u00E4ngig machen", 1200);
      return;
    }
    if (undoLocalSnapshot()) return;
    undoInProgress = true;
    try {
      await undoPreviousVersion();
    } finally {
      undoInProgress = false;
    }
  }

  // Restore the most recent history snapshot on the most recently active page.
  // Returns true if a local undo was performed, false if no local history remains.
  function undoLocalSnapshot() {
    const currentPage = window.state?.viewer?.currentPage;
    const candidates = [];
    if (currentPage && pages.has(currentPage)) candidates.push(currentPage);
    if (lastActivePage && lastActivePage !== currentPage && pages.has(lastActivePage)) candidates.push(lastActivePage);
    const remaining = Array.from(pages.keys()).filter((n) => !candidates.includes(n)).reverse();
    const pageOrder = [...candidates, ...remaining];

    for (const pageNumber of pageOrder) {
      const entry = pages.get(pageNumber);
      if (!entry || !entry.history.length) continue;
      if (!entry.storageCanvas || !entry.storageCtx) continue;

      // Capture current state for redo
      let currentSnap = null;
      try {
        currentSnap = entry.storageCtx.getImageData(
          0, 0, entry.storageCanvas.width, entry.storageCanvas.height
        );
      } catch {}

      const snapshot = entry.history.pop();
      try {
        entry.storageCtx.putImageData(snapshot, 0, 0);
      } catch {
        return false;
      }

      if (currentSnap) entry.redoStack.push(currentSnap);

      entry.hasContent = imageDataHasContent(snapshot);
      entry.dirty = entry.hasContent;
      entry.needsUpload = true;
      entry.activePointers.clear();
      syncCommitFromStorage(entry);
      redrawOverlay(entry);
      queueSave(pageNumber);
      setLastAction("R\u00FCckg\u00E4ngig");
      updateUndoState();
      showStatus("Aktion r\u00FCckg\u00E4ngig", 1200);
      return true;
    }
    return false;
  }

  async function undoPreviousVersion() {
    if (!fileName) {
      showStatus("Keine Datei ausgew\u00E4hlt", 1400);
      return;
    }
    if (saving) {
      showStatus("Bitte warten, Notizen werden gespeichert", 1600);
      return;
    }

    showStatus("Vorherige Version laden\u2026");
    try {
      const response = await (fetcher || window.fetch)("/api/annotations/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: fileName }),
        cache: "no-store"
      });

      if (response.status === 409) {
        serverUndoAvailable = false;
        updateUndoState();
        updateStatusLine();
        showStatus("Originalversion \u2014 kein weiteres R\u00FCckg\u00E4ngig m\u00F6glich", 2200);
        return;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

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
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (idleCallback && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleCallback);
        idleCallback = null;
      }

      pages.forEach((entry, pageNumber) => {
        entry.history = [];
        entry.redoStack = [];
        entry.activePointers.clear();
        entry.dirty = false;
        entry.overlayDirty = false;
        entry.overlayNeedsFullRedraw = true;
        entry.needsUpload = false;
        if (entry.overlayCtx && entry.overlay) {
          entry.overlayCtx.clearRect(0, 0, entry.overlay.width, entry.overlay.height);
        }
        const snapshot = snapshotMap.get(pageNumber);
        primeCommittedImage(pageNumber, snapshot || { pageNumber, dataUrl: null });
      });

      snapshotMap.forEach((snapshot, pageNumber) => {
        if (!pages.has(pageNumber)) primeCommittedImage(pageNumber, snapshot);
      });

      lastActivePage = null;
      setLastAction("Version geladen");
      showStatus("Vorherige Version geladen", 1600);

      const mtimeValue = Number(payload?.mtime);
      const sizeValue = Number(payload?.size);
      const changedPages = Array.from(changedSet).filter((page) => Number.isInteger(page) && page > 0);
      const historyRemaining = Number(payload?.historyRemaining);
      serverUndoAvailable = Number.isFinite(historyRemaining) ? historyRemaining > 0 : serverUndoAvailable;
      updateUndoState();
      updateStatusLine();
      if (typeof onSaved === "function") {
        onSaved({
          mtime: Number.isFinite(mtimeValue) ? mtimeValue : null,
          size: Number.isFinite(sizeValue) ? sizeValue : null,
          pages: changedPages
        });
      }
    } catch (err) {
      console.error("Annotation version undo failed", err);
      showStatus("Version konnte nicht geladen werden", 2000, { toast: true });
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
      if (targetPage) lastActivePage = targetPage;
    }

    if (!targetPage) { showStatus("Keine Seite im Fokus", 1400); return; }

    const entry = pages.get(targetPage);
    if (!entry) { showStatus("Seite nicht geladen", 1400); return; }

    const hasVisibleContent = entry.hasContent || (entry.activePointers && entry.activePointers.size > 0);
    if (!hasVisibleContent) { showStatus("Keine Notizen vorhanden", 1200); return; }

    ensureStorageCanvas(entry);
    pushHistory(entry);

    entry.activePointers.clear();
    if (entry.storageCtx && entry.storageCanvas) {
      clearCanvas(entry.storageCtx, entry.storageCanvas);
    }
    entry.hasContent = false;
    entry.dirty = true;
    entry.needsUpload = true;
    entry.overlayNeedsFullRedraw = true;

    syncCommitFromStorage(entry);
    redrawOverlay(entry);

    queueSave(entry.pageNumber, { immediate: true });
    setLastAction("Seite geleert");
    updateUndoState();
    showStatus("Seite geleert", 1600);
  }

  function setActiveState(next, opts = {}) {
    const changed = opts.force ? true : next !== active;
    if (!changed) return;
    active = next;
    document.body.classList.toggle("annotations-active", active);
    if (!active) clearPenPointers();
    updateToggleUI();
    refreshOverlayActivation();
    if (!opts.silent) {
      if (active) showStatus("Notizen aktiv", 1400);
      else updateStatus();
    }
    const controlsRoot = document.getElementById("controls");
    if (controlsRoot && controlsRoot.classList.contains("controls-minimized") && active) {
      setActiveState(false, { silent: true, force: true });
    }
  }

  function selectTool(tool) {
    if (!TOOL_CONFIG[tool]) tool = "pen";
    if (options.tool === tool) return;
    options.tool = tool;
    updateToolButtons();
    refreshOverlayActivation();
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
    if (active) {
      controls.toggle.classList.add("annotation-toggle-active");
    } else {
      controls.toggle.classList.remove("annotation-toggle-active");
    }
    controls.toggle.setAttribute("aria-pressed", active ? "true" : "false");
    if (controls.toolbar) {
      if (active) {
        controls.toolbar.classList.add("is-open");
        controls.toolbar.style.display = "flex";
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

  function updateInputModeButtons() {
    if (controls.inputPenBtn) {
      controls.inputPenBtn.setAttribute("aria-pressed", inputMode === INPUT_MODES.PEN_ONLY ? "true" : "false");
    }
    if (controls.inputBothBtn) {
      controls.inputBothBtn.setAttribute("aria-pressed", inputMode === INPUT_MODES.BOTH ? "true" : "false");
    }
  }

  function updatePresetButtons() {
    if (!controls.presetApplyBtn) return;
    const hasPreset = Boolean(savedPreset);
    controls.presetApplyBtn.disabled = !hasPreset;
    controls.presetApplyBtn.setAttribute("aria-disabled", hasPreset ? "false" : "true");
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

  function setPencilActive(next) {
    pencilActive = next;
    if (controls.pencilBadge) {
      controls.pencilBadge.classList.toggle("hidden", !pencilActive);
      controls.pencilBadge.style.display = pencilActive ? "inline-flex" : "none";
    }
  }

  function markPencilActive() {
    setPencilActive(true);
    if (pencilTimer) clearTimeout(pencilTimer);
    pencilTimer = window.setTimeout(() => {
      pencilTimer = null;
      setPencilActive(false);
    }, 2000);
  }

  function setInputMode(mode) {
    const next = mode === INPUT_MODES.BOTH ? INPUT_MODES.BOTH : INPUT_MODES.PEN_ONLY;
    if (next === inputMode) return;
    inputMode = next;
    updateInputModeButtons();
    refreshOverlayActivation();
  }

  function setPreset(preset) {
    savedPreset = preset && typeof preset === "object" ? { ...preset } : null;
    updatePresetButtons();
    if (!savedPreset) return;
    if (savedPreset.tool) selectTool(savedPreset.tool);
    if (savedPreset.color) selectColor(savedPreset.color);
    if (Number.isFinite(Number(savedPreset.size))) setSize(Number(savedPreset.size));
  }

  function applyPreset() {
    if (!savedPreset) return false;
    if (savedPreset.tool) selectTool(savedPreset.tool);
    if (savedPreset.color) selectColor(savedPreset.color);
    if (Number.isFinite(Number(savedPreset.size))) setSize(Number(savedPreset.size));
    return true;
  }

  function getToolState() {
    return { tool: options.tool, color: options.color, size: options.size };
  }

  function setServerUndoAvailable(flag) {
    serverUndoAvailable = Boolean(flag);
    updateUndoState();
    updateStatusLine();
  }

  function hasLocalUndo() {
    for (const entry of pages.values()) {
      if (entry.history && entry.history.length) return true;
    }
    return false;
  }

  function canUndo() {
    return hasLocalUndo() || serverUndoAvailable;
  }

  function updateUndoState() {
    if (!controls.undoBtn) return;
    const enabled = canUndo();
    controls.undoBtn.disabled = !enabled;
    controls.undoBtn.setAttribute("aria-disabled", enabled ? "false" : "true");
  }

  function updateStatusLine() {
    if (!controls.statusLine) return;
    let text = "";
    if (statusOverride) {
      text = statusOverride;
    } else if (!canUndo()) {
      text = "Nichts zum R\u00FCckg\u00E4ngig machen";
    } else if (lastActionLabel) {
      text = `Letzte Aktion: ${lastActionLabel}`;
    }
    controls.statusLine.textContent = text || "";
  }

  function setLastAction(label) {
    lastActionLabel = label || "";
    statusOverride = null;
    updateStatusLine();
  }

  function showStatus(message, delay, opts = {}) {
    clearStatusTimer();
    if (!message) {
      statusOverride = null;
      updateStatusLine();
      return;
    }
    statusOverride = message;
    updateStatusLine();
    if (opts.toast) updateStatus(message);
    if (delay && delay > 0) {
      statusResetTimer = window.setTimeout(() => {
        statusResetTimer = null;
        statusOverride = null;
        updateStatusLine();
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
    showStatus: (message, delay, opts = {}) => showStatus(message, delay, opts),
    setInputMode,
    setPreset,
    applyPreset,
    getToolState,
    setServerUndoAvailable,
    getUndoState: () => ({
      localUndo: hasLocalUndo(),
      serverUndo: serverUndoAvailable,
      canUndo: canUndo()
    }),
    clearRedo: () => {
      pages.forEach((entry) => { entry.redoStack = []; });
    }
  };

  Object.defineProperty(api, "primeCommittedImage", {
    value: (pageNumber, payload) => primeCommittedImage(pageNumber, payload),
    enumerable: true
  });

  return api;
}
