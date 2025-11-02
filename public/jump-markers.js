(() => {
  const ROLE_ICONS = { source: "↩", target: "★" };
  const ROLE_NAMES = { source: "Absprung", target: "Ziel" };

  const PANEL_POSITION_KEY = "jumpMarkers.panel.position";

  const uiState = {
    stylesInjected: false,
    initialized: false,
  panel: null,
  panelList: null,
  panelEmpty: null,
  panelStatus: null,
  btnNew: null,
  btnCancelPlacement: null,
  btnClose: null,
    placement: null,
    focusedPairId: null,
    editButton: null,
    toggleEditHandler: null,
    viewerEl: null,
    panelDrag: null,
    resizeHandlerBound: false,
    connectTimer: null
  };

  function safeUpdateStatus(message) {
    if (typeof window.updateStatus === "function") {
      window.updateStatus(message);
      return;
    }
    const statusEl = document.querySelector("#status");
    if (statusEl) {
      statusEl.textContent = message || "";
    } else if (message) {
      console.log("[JumpMarkers]", message);
    }
  }

  function ensureStyles() {
    if (uiState.stylesInjected) return;
    uiState.stylesInjected = true;
    const style = document.createElement("style");
    style.id = "jump-marker-styles";
    style.textContent = `
      .jump-marker-overlay {
        position: absolute;
        transform: translate(-50%, -50%);
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.55rem 0.92rem;
        border-radius: 9999px;
        border: 1px solid rgba(255, 255, 255, 0.22);
        background: linear-gradient(135deg, rgba(59,130,246,0.35), rgba(14,165,233,0.3));
        box-shadow: 0 18px 45px rgba(15,23,42,0.35);
        backdrop-filter: blur(16px) saturate(140%);
        color: #f8fafc;
        font-size: 0.82rem;
        line-height: 1.2;
        cursor: pointer;
        z-index: 40;
        min-width: 144px;
        transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease, background 0.18s ease, opacity 0.18s ease;
        appearance: none;
        pointer-events: auto;
      }
      .jump-marker-overlay[data-role="source"] {
        background: linear-gradient(135deg, rgba(129,140,248,0.42), rgba(79,70,229,0.36));
        border-color: rgba(129,140,248,0.48);
      }
      .jump-marker-overlay[data-role="target"] {
        background: linear-gradient(135deg, rgba(16,185,129,0.4), rgba(5,150,105,0.34));
        border-color: rgba(16,185,129,0.48);
      }
      .jump-marker-overlay .jump-icon {
        font-size: 1.22rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .jump-marker-overlay .jump-text {
        display: flex;
        flex-direction: column;
        text-align: left;
        gap: 0.08rem;
      }
      .jump-marker-overlay .jump-title {
        font-weight: 600;
        letter-spacing: 0.01em;
        color: #f9fafb;
      }
      .jump-marker-overlay .jump-role {
        font-size: 0.68rem;
        opacity: 0.75;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .jump-marker-overlay:focus-visible {
        outline: 2px solid rgba(96,165,250,0.75);
        outline-offset: 2px;
      }
      .jump-marker-overlay.is-placing {
        border-style: dashed;
        animation: jumpMarkerPulse 1.1s ease infinite;
      }
      .jump-marker-overlay.is-highlighted {
        animation: jumpMarkerFlash 0.8s ease 0s 3;
      }
      @keyframes jumpMarkerPulse {
        0%, 100% { transform: translate(-50%, -50%) scale(1); }
        50% { transform: translate(-50%, -50%) scale(1.04); }
      }
      @keyframes jumpMarkerFlash {
        0% { box-shadow: 0 0 0 rgba(96,165,250,0.0); }
        50% { box-shadow: 0 0 24px rgba(96,165,250,0.65); }
        100% { box-shadow: 0 0 0 rgba(96,165,250,0.0); }
      }
      .jump-marker-panel {
        position: fixed;
        top: 112px;
        right: 28px;
        width: min(320px, calc(100vw - 32px));
        display: none;
        flex-direction: column;
        gap: 1rem;
        padding: 1.35rem;
        border-radius: 20px;
        border: 1px solid rgba(148,163,184,0.18);
        background: linear-gradient(155deg, rgba(15,23,42,0.9), rgba(30,41,59,0.92));
        box-shadow: 0 26px 70px rgba(15,23,42,0.55);
        backdrop-filter: blur(18px);
        color: #f1f5f9;
        z-index: 90;
      }
      .jump-marker-panel.is-dragging {
        cursor: grabbing;
      }
      .jump-marker-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .jump-marker-panel-title {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        cursor: grab;
        user-select: none;
        touch-action: none;
      }
      .jump-marker-panel.is-dragging .jump-marker-panel-title {
        cursor: grabbing;
      }
      .jump-marker-panel-drag-indicator {
        font-size: 1.25rem;
        line-height: 1;
        opacity: 0.6;
      }
      .jump-marker-panel-close {
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 9999px;
        border: 1px solid rgba(148,163,184,0.32);
        background: rgba(30,41,59,0.78);
        color: #e2e8f0;
        cursor: pointer;
        transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease;
      }
      .jump-marker-panel-close:hover,
      .jump-marker-panel-close:focus-visible {
        border-color: rgba(96,165,250,0.55);
        background: rgba(59,130,246,0.55);
        color: #0f172a;
        outline: none;
      }
      .jump-marker-panel-close span {
        font-size: 1.35rem;
        line-height: 1;
      }
      .jump-marker-panel h3 {
        margin: 0;
        font-size: 1.05rem;
        font-weight: 600;
        letter-spacing: 0.02em;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .jump-marker-panel-status {
        font-size: 0.82rem;
        line-height: 1.35;
        color: rgba(209,213,219,0.85);
      }
      .jump-marker-panel-status.info { color: #93c5fd; }
      .jump-marker-panel-status.warn { color: #fbbf24; }
      .jump-marker-panel-status.success { color: #6ee7b7; }
      .jump-marker-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem;
      }
      .jump-marker-actions button {
        flex: 1 1 auto;
        min-width: 120px;
        padding: 0.55rem 0.75rem;
        border-radius: 12px;
        border: 1px solid rgba(148,163,184,0.32);
        background: rgba(30,41,59,0.72);
        color: #e2e8f0;
        font-weight: 600;
        font-size: 0.8rem;
        cursor: pointer;
        transition: border 0.18s ease, background 0.18s ease, transform 0.18s ease;
      }
      .jump-marker-actions button:hover {
        border-color: rgba(96,165,250,0.6);
        background: rgba(30,41,59,0.9);
        transform: translateY(-1px);
      }
      .jump-marker-actions button[disabled] {
        cursor: not-allowed;
        opacity: 0.45;
        transform: none;
      }
      .jump-marker-list {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        max-height: 56vh;
        overflow-y: auto;
        padding-right: 4px;
      }
      .jump-marker-empty {
        font-size: 0.82rem;
        line-height: 1.35;
        color: rgba(203,213,225,0.75);
        border: 1px dashed rgba(148,163,184,0.3);
        border-radius: 14px;
        padding: 0.9rem;
        background: rgba(15,23,42,0.35);
      }
      .jump-marker-item {
        border-radius: 14px;
        border: 1px solid rgba(148,163,184,0.24);
        background: rgba(23,37,84,0.38);
        padding: 0.85rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.65rem;
        transition: border 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
      }
      .jump-marker-item.is-active {
        border-color: rgba(96,165,250,0.65);
        box-shadow: 0 16px 35px rgba(14,116,144,0.35);
        transform: translateY(-1px);
      }
      .jump-marker-item-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .jump-marker-label {
        background: none;
        border: none;
        padding: 0;
        color: #e0f2fe;
        font-size: 0.95rem;
        font-weight: 600;
        letter-spacing: 0.01em;
        cursor: pointer;
      }
      .jump-marker-label:hover,
      .jump-marker-label:focus-visible {
        text-decoration: underline;
        outline: none;
      }
      .jump-marker-test {
        border-radius: 10px;
        padding: 0.4rem 0.6rem;
        border: 1px solid rgba(148,163,184,0.3);
        background: rgba(15,118,110,0.25);
        color: #99f6e4;
        font-size: 0.75rem;
        font-weight: 600;
        cursor: pointer;
      }
      .jump-marker-test[disabled] {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .jump-marker-points {
        display: grid;
        gap: 0.45rem;
        font-size: 0.76rem;
        color: rgba(226,232,240,0.85);
      }
      .jump-marker-point-title {
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        font-size: 0.7rem;
        opacity: 0.75;
      }
      .jump-marker-point-meta {
        font-size: 0.78rem;
        display: flex;
        align-items: center;
        gap: 0.4rem;
      }
      .jump-marker-item-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
      }
      .jump-marker-item-actions button {
        flex: 1 1 48%;
        min-width: 120px;
        padding: 0.5rem 0.6rem;
        border-radius: 10px;
        border: 1px solid rgba(148,163,184,0.28);
        background: rgba(30,41,59,0.68);
        color: #e2e8f0;
        font-size: 0.75rem;
        font-weight: 600;
        cursor: pointer;
      }
      .jump-marker-item-actions button:hover {
        border-color: rgba(96,165,250,0.55);
        background: rgba(30,41,59,0.9);
      }
      .jump-marker-item-actions button[data-action="delete"] {
        border-color: rgba(239,68,68,0.35);
        background: rgba(127,29,29,0.3);
        color: #fecaca;
      }
      .jump-marker-item-actions button[data-action="delete"]:hover {
        border-color: rgba(239,68,68,0.55);
        background: rgba(127,29,29,0.45);
      }
      @media (max-width: 900px) {
        .jump-marker-panel {
          top: auto;
          bottom: 24px;
          right: 20px;
          width: min(320px, calc(100vw - 40px));
        }
      }
      .jump-marker-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(15,23,42,0.6);
        display: grid;
        place-items: center;
        z-index: 10000;
        backdrop-filter: blur(12px);
      }
      .jump-marker-modal {
        width: min(480px, 92vw);
        background: rgba(15,23,42,0.95);
        border-radius: 20px;
        border: 1px solid rgba(148,163,184,0.25);
        padding: 1.8rem;
        color: #e2e8f0;
        box-shadow: 0 32px 70px rgba(15,23,42,0.55);
      }
      .jump-marker-modal h3 {
        margin-top: 0;
        margin-bottom: 1.1rem;
        font-size: 1.1rem;
        font-weight: 600;
        color: #f8fafc;
      }
      .jump-marker-modal label {
        display: block;
        font-size: 0.78rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 0.35rem;
        color: rgba(203,213,225,0.82);
      }
      .jump-marker-modal input[type="text"] {
        width: 100%;
        border-radius: 12px;
        border: 1px solid rgba(148,163,184,0.35);
        background: rgba(15,23,42,0.7);
        color: #f1f5f9;
        padding: 0.65rem 0.8rem;
        font-size: 0.95rem;
      }
      .jump-marker-modal input[type="text"]:focus {
        outline: 2px solid rgba(96,165,250,0.65);
        outline-offset: 2px;
      }
      .jump-marker-modal .actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.65rem;
        margin-top: 1.5rem;
      }
      .jump-marker-modal button {
        padding: 0.55rem 1.05rem;
        border-radius: 12px;
        border: 1px solid transparent;
        font-weight: 600;
        cursor: pointer;
      }
      .jump-marker-modal .btn-secondary {
        border-color: rgba(148,163,184,0.3);
        background: rgba(30,41,59,0.8);
        color: #e2e8f0;
      }
      .jump-marker-modal .btn-primary {
        background: linear-gradient(135deg, rgba(96,165,250,0.9), rgba(129,140,248,0.9));
        color: #0f172a;
      }
      .jump-marker-modal .btn-danger {
        border-color: rgba(239,68,68,0.45);
        background: rgba(127,29,29,0.35);
        color: #fecaca;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureStateShape() {
    if (!window.state) window.state = {};
    if (!state.viewer) state.viewer = {};
    if (!Array.isArray(state.viewer.jumpMarkers)) {
      state.viewer.jumpMarkers = [];
    }
  }

  function getMarkers() {
    ensureStateShape();
    return state.viewer.jumpMarkers;
  }

  function getViewer() {
    return document.querySelector("#viewer");
  }

  function getPageElement(pageNumber) {
    return document.querySelector(`[data-page="${pageNumber}"]`);
  }

  function getPageNumberFromElement(el) {
    const pageEl = el?.closest("[data-page]");
    if (!pageEl) return null;
    const num = Number(pageEl.dataset.page);
    return Number.isFinite(num) ? num : null;
  }

  function clampPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(100, Math.round(num * 1000) / 1000));
  }

  function isPoint(point) {
    return Boolean(point && Number.isFinite(point.pageNumber) && Number.isFinite(point.x) && Number.isFinite(point.y));
  }

  function isComplete(pair) {
    return isPoint(pair?.source) && isPoint(pair?.target);
  }

  function setPanelHint(text, tone = "muted") {
    if (!uiState.panelStatus) return;
    uiState.panelStatus.textContent = text || "";
    uiState.panelStatus.classList.remove("info", "warn", "success");
    if (tone === "info" || tone === "warn" || tone === "success") {
      uiState.panelStatus.classList.add(tone);
    }
  }

  function setPanelVisibility(show) {
    if (!uiState.panel) return;
    uiState.panel.style.display = show ? "flex" : "none";
  }

  function buildPanel() {
    if (uiState.panel) return;
    const panel = document.createElement("aside");
    panel.className = "jump-marker-panel";
    panel.innerHTML = `
      <div class="jump-marker-panel-header">
        <div class="jump-marker-panel-title" data-role="drag-handle">
          <h3>Sprungmarken</h3>
          <span class="jump-marker-panel-drag-indicator" aria-hidden="true">::</span>
        </div>
        <button type="button" class="jump-marker-panel-close" data-role="close" title="Sprungmarken schließen" aria-label="Sprungmarken schließen">
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
      <p class="jump-marker-panel-status" data-role="status"></p>
      <div class="jump-marker-actions">
        <button type="button" data-role="new">Neuer Sprung</button>
        <button type="button" data-role="cancel" hidden>Platzierung abbrechen</button>
      </div>
      <div class="jump-marker-empty" data-role="empty">Noch keine Sprungmarken vorhanden. Lege einen Absprung und ein Ziel an, um manuell springen zu können.</div>
      <div class="jump-marker-list" data-role="list"></div>
    `;
    document.body.appendChild(panel);
    uiState.panel = panel;
    uiState.panelStatus = panel.querySelector('[data-role="status"]');
    uiState.panelList = panel.querySelector('[data-role="list"]');
    uiState.panelEmpty = panel.querySelector('[data-role="empty"]');
    uiState.btnNew = panel.querySelector('[data-role="new"]');
    uiState.btnCancelPlacement = panel.querySelector('[data-role="cancel"]');
    uiState.btnClose = panel.querySelector('[data-role="close"]');

    uiState.btnNew.addEventListener("click", () => openCreateModal());
    uiState.btnCancelPlacement.addEventListener("click", () => cancelPlacement({ userTriggered: true }));
    if (uiState.btnClose) {
      uiState.btnClose.addEventListener("click", () => {
        if (state.viewer?.editMode) {
          toggleEditMode();
        } else {
          setPanelVisibility(false);
        }
      });
    }

    bindPanelDrag();
    restorePanelPosition();
    if (!uiState.resizeHandlerBound) {
      window.addEventListener("resize", handleWindowResize);
      uiState.resizeHandlerBound = true;
    }
  }

  function bindPanelDrag() {
    const handle = uiState.panel?.querySelector('[data-role="drag-handle"]');
    if (!handle) return;
    handle.addEventListener("pointerdown", handlePanelPointerDown);
  }

  function handlePanelPointerDown(event) {
    if (!uiState.panel || event.button !== 0) return;
    event.preventDefault();
    const rect = uiState.panel.getBoundingClientRect();
    uiState.panelDrag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      latestLeft: rect.left,
      latestTop: rect.top
    };
    uiState.panel.classList.add("is-dragging");
    uiState.panel.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", handlePanelPointerMove);
    window.addEventListener("pointerup", handlePanelPointerUp);
    window.addEventListener("pointercancel", handlePanelPointerUp);
  }

  function handlePanelPointerMove(event) {
    const drag = uiState.panelDrag;
    if (!drag || event.pointerId !== drag.pointerId || !uiState.panel) return;
    const proposedLeft = event.clientX - drag.offsetX;
    const proposedTop = event.clientY - drag.offsetY;
    const { left, top } = clampPanelPosition(proposedLeft, proposedTop);
    applyPanelPosition(left, top);
    drag.latestLeft = left;
    drag.latestTop = top;
  }

  function handlePanelPointerUp(event) {
    const drag = uiState.panelDrag;
    if (!drag || event.pointerId !== drag.pointerId || !uiState.panel) return;
    window.removeEventListener("pointermove", handlePanelPointerMove);
    window.removeEventListener("pointerup", handlePanelPointerUp);
  window.removeEventListener("pointercancel", handlePanelPointerUp);
    uiState.panel.classList.remove("is-dragging");
    uiState.panel.releasePointerCapture?.(event.pointerId);
    if (uiState.panel.dataset.positionMode !== "custom") {
      applyPanelPosition(drag.latestLeft, drag.latestTop);
    }
    persistPanelPosition(drag.latestLeft, drag.latestTop);
    uiState.panelDrag = null;
  }

  function clampPanelPosition(left, top) {
    if (!uiState.panel) return { left, top };
    const minMargin = 12;
    const width = uiState.panel.offsetWidth || uiState.panel.getBoundingClientRect().width || 0;
    const height = uiState.panel.offsetHeight || uiState.panel.getBoundingClientRect().height || 0;
    const maxLeft = Math.max(minMargin, window.innerWidth - width - minMargin);
    const maxTop = Math.max(minMargin, window.innerHeight - height - minMargin);
    const clampedLeft = Math.min(Math.max(minMargin, left), maxLeft);
    const clampedTop = Math.min(Math.max(minMargin, top), maxTop);
    return { left: clampedLeft, top: clampedTop };
  }

  function applyPanelPosition(left, top) {
    if (!uiState.panel) return;
    uiState.panel.style.left = `${Math.round(left)}px`;
    uiState.panel.style.top = `${Math.round(top)}px`;
    uiState.panel.style.right = "auto";
    uiState.panel.style.bottom = "auto";
    uiState.panel.dataset.positionMode = "custom";
  }

  function persistPanelPosition(left, top) {
    if (typeof left !== "number" || typeof top !== "number") return;
    try {
      localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify({ left, top }));
    } catch {}
  }

  function restorePanelPosition() {
    if (!uiState.panel) return;
    let stored = null;
    try {
      const raw = localStorage.getItem(PANEL_POSITION_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
    if (!stored || typeof stored.left !== "number" || typeof stored.top !== "number") {
      return;
    }
    const previousDisplay = uiState.panel.style.display;
    const previousVisibility = uiState.panel.style.visibility;
    const computedDisplay = window.getComputedStyle(uiState.panel).display;
    const needsTempDisplay = computedDisplay === "none";
    if (needsTempDisplay) {
      uiState.panel.style.visibility = "hidden";
      uiState.panel.style.display = "flex";
    }
    const { left, top } = clampPanelPosition(stored.left, stored.top);
    applyPanelPosition(left, top);
    if (needsTempDisplay) {
      uiState.panel.style.display = previousDisplay;
      uiState.panel.style.visibility = previousVisibility;
    }
  }

  function handleWindowResize() {
    if (!uiState.panel || uiState.panel.dataset.positionMode !== "custom") return;
    const rect = uiState.panel.getBoundingClientRect();
    const { left, top } = clampPanelPosition(rect.left, rect.top);
    applyPanelPosition(left, top);
    persistPanelPosition(left, top);
  }

  function bindEditButton(enable = true) {
    const btn = document.querySelector("#btnEditMarkers");
    if (uiState.editButton && uiState.editButton !== btn && uiState.toggleEditHandler) {
      uiState.editButton.removeEventListener("click", uiState.toggleEditHandler);
    }
    if (!btn) {
      uiState.editButton = null;
      return;
    }
    if (!uiState.toggleEditHandler) {
      uiState.toggleEditHandler = () => toggleEditMode();
    }
    if (uiState.editButton !== btn) {
      uiState.editButton = btn;
      btn.addEventListener("click", uiState.toggleEditHandler);
    }
    applyEditButtonAppearance(btn);
    btn.disabled = !enable;
  }

  function applyEditButtonAppearance(btn) {
    if (!btn) return;
    const isActive = Boolean(state.viewer?.editMode);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    if (isActive) {
      btn.classList.remove("btn-secondary");
      btn.classList.add("btn-primary", "is-ready");
    } else {
      btn.classList.remove("btn-primary", "is-ready");
      btn.classList.add("btn-secondary");
    }
  }

  function bindViewerElement() {
    const viewer = getViewer();
    if (uiState.viewerEl && uiState.viewerEl !== viewer) {
      uiState.viewerEl.removeEventListener("click", handleViewerClick, true);
      uiState.viewerEl = null;
    }
    if (viewer && uiState.viewerEl !== viewer) {
      viewer.addEventListener("click", handleViewerClick, true);
      uiState.viewerEl = viewer;
    }
  }

  function connectToViewer() {
  bindEditButton(true);
    bindViewerElement();
    setPanelVisibility(Boolean(state.viewer?.editMode));
    renderPanel();
    renderAllMarkers();
  }

  function tryConnectViewer() {
    if (!state.viewer?.fileName) return false;
    const viewer = getViewer();
    if (!viewer) return false;
    connectToViewer();
    return true;
  }

  function renderPanel() {
    if (!uiState.panel) return;
    const markers = getMarkers();
    const hasMarkers = markers.length > 0;
    uiState.panelEmpty.style.display = hasMarkers ? "none" : "block";
    uiState.panelList.innerHTML = "";
    markers.forEach((pair) => {
      const item = renderPanelItem(pair);
      if (item) uiState.panelList.appendChild(item);
    });
    if (!uiState.placement) {
      setPanelHint(hasMarkers ? "Wähle einen Sprung zum Bearbeiten oder nutze 'Neuer Sprung'." : "Lege zuerst einen Absprung an. Danach folgt automatisch das Ziel.");
    }
  }

  function formatPoint(point) {
    if (!isPoint(point)) return "Noch nicht gesetzt";
    return `Seite ${point.pageNumber} • x ${Math.round(point.x)}% · y ${Math.round(point.y)}%`;
  }

  function renderPanelItem(pair) {
    const item = document.createElement("div");
    item.className = "jump-marker-item";
    item.dataset.pairId = pair.id;
    if (uiState.focusedPairId === pair.id || uiState.placement?.pairId === pair.id) {
      item.classList.add("is-active");
    }
    item.innerHTML = `
      <div class="jump-marker-item-header">
        <button type="button" class="jump-marker-label" data-action="rename">${pair.label}</button>
        <button type="button" class="jump-marker-test" data-action="test" ${isComplete(pair) ? "" : "disabled"}>Springen</button>
      </div>
      <div class="jump-marker-points">
        <div>
          <div class="jump-marker-point-title">Absprung</div>
          <div class="jump-marker-point-meta">${formatPoint(pair.source)}</div>
        </div>
        <div>
          <div class="jump-marker-point-title">Ziel</div>
          <div class="jump-marker-point-meta">${formatPoint(pair.target)}</div>
        </div>
      </div>
      <div class="jump-marker-item-actions">
        <button type="button" data-action="set-source">${isPoint(pair.source) ? "Absprung anpassen" : "Absprung setzen"}</button>
        <button type="button" data-action="set-target">${isPoint(pair.target) ? "Ziel anpassen" : "Ziel setzen"}</button>
        <button type="button" data-action="delete">Löschen</button>
      </div>
    `;

    item.querySelector('[data-action="rename"]').addEventListener("click", () => openRenameModal(pair));
    item.querySelector('[data-action="test"]').addEventListener("click", () => {
      if (isComplete(pair)) {
        jumpFromPair(pair);
      }
    });
    item.querySelector('[data-action="set-source"]').addEventListener("click", () => {
      const autoAdvance = !isPoint(pair.target);
      startPlacement(pair.id, "source", { autoAdvance });
    });
    item.querySelector('[data-action="set-target"]').addEventListener("click", () => {
      startPlacement(pair.id, "target", { autoAdvance: false });
    });
    item.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      const confirmed = window.confirm(`${pair.label} löschen?`);
      if (!confirmed) return;
      deletePair(pair.id);
      await saveJumpMarkers("Sprung gelöscht");
    });
    return item;
  }

  function startPlacement(pairId, role, options = {}) {
    const pair = getMarkers().find((m) => m.id === pairId);
    if (!pair) return;
    uiState.placement = {
      pairId,
      role,
      autoAdvance: Boolean(options.autoAdvance)
    };
    uiState.focusedPairId = pairId;
    if (uiState.btnCancelPlacement) {
      uiState.btnCancelPlacement.hidden = false;
    }
    const label = ROLE_NAMES[role];
    setPanelHint(`Klicke im PDF, um den ${label.toLowerCase()} für "${pair.label}" zu platzieren.`, "info");
    renderPanel();
    renderAllMarkers();
  }

  function cancelPlacement({ userTriggered = false, keepDraft = false } = {}) {
    if (!uiState.placement) return;
    const { pairId } = uiState.placement;
    uiState.placement = null;
    if (uiState.btnCancelPlacement) {
      uiState.btnCancelPlacement.hidden = true;
    }
    const markers = getMarkers();
    const idx = markers.findIndex((p) => p.id === pairId);
    if (idx !== -1 && !keepDraft) {
      const pair = markers[idx];
      if (!isPoint(pair.source) && !isPoint(pair.target)) {
        markers.splice(idx, 1);
      }
    }
    setPanelHint(userTriggered ? "Platzierung abgebrochen." : "");
    renderPanel();
    renderAllMarkers();
    if (!keepDraft) {
      saveJumpMarkers(null);
    }
  }

  function getRelativeCoordinates(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    const x = clampPercent(((event.clientX - rect.left) / rect.width) * 100);
    const y = clampPercent(((event.clientY - rect.top) / rect.height) * 100);
    return { x, y };
  }

  function handleViewerClick(event) {
    if (!state.viewer?.editMode) return;
    const placement = uiState.placement;
    if (!placement) return;
    if (event.target.closest(".jump-marker-overlay")) return;
    const canvas = event.target.closest("canvas");
    if (!canvas) return;
    event.preventDefault();
    event.stopPropagation();
    const pageNumber = getPageNumberFromElement(canvas);
    if (!pageNumber) return;
    const coords = getRelativeCoordinates(event, canvas);
    applyPlacement(pageNumber, coords);
  }

  async function applyPlacement(pageNumber, coords) {
    const placement = uiState.placement;
    if (!placement) return;
    const pair = getMarkers().find((m) => m.id === placement.pairId);
    if (!pair) return;
    const point = { pageNumber, x: coords.x, y: coords.y };
    pair[placement.role] = point;

    const roleName = ROLE_NAMES[placement.role];
    safeUpdateStatus(`${pair.label}: ${roleName} gespeichert (Seite ${pageNumber}).`);

    const autoAdvance = placement.autoAdvance && placement.role === "source" && !isPoint(pair.target);
    uiState.placement = autoAdvance ? { pairId: pair.id, role: "target", autoAdvance: false } : null;
    if (uiState.btnCancelPlacement) {
      uiState.btnCancelPlacement.hidden = !uiState.placement;
    }

    renderPanel();
    renderAllMarkers();

    const complete = isComplete(pair);
    await saveJumpMarkers(complete ? "Sprung gespeichert" : null);

    if (autoAdvance) {
      setPanelHint(`Absprung gespeichert. Jetzt das Ziel für "${pair.label}" wählen.`, "info");
    } else if (!complete) {
      setPanelHint("Ziel noch nicht gesetzt.", "warn");
    }
  }

  function createOverlay(pair, role, point) {
    if (!isPoint(point)) return null;
    const pageEl = getPageElement(point.pageNumber);
    if (!pageEl) return null;
    if (window.getComputedStyle(pageEl).position === "static") {
      pageEl.style.position = "relative";
    }
    const overlay = document.createElement("button");
    overlay.type = "button";
    overlay.className = "jump-marker-overlay";
    overlay.dataset.pairId = pair.id;
    overlay.dataset.role = role;
    overlay.dataset.pageNumber = String(point.pageNumber);
    overlay.style.left = `${point.x}%`;
    overlay.style.top = `${point.y}%`;
    overlay.innerHTML = `
      <span class="jump-icon">${ROLE_ICONS[role]}</span>
      <span class="jump-text">
        <span class="jump-title">${pair.label}</span>
        <span class="jump-role">${ROLE_NAMES[role]}</span>
      </span>
    `;
    if (uiState.placement && uiState.placement.pairId === pair.id && uiState.placement.role === role) {
      overlay.classList.add("is-placing");
    }
    overlay.addEventListener("click", (event) => {
      event.stopPropagation();
      handleOverlayClick(pair, role);
    });
    pageEl.appendChild(overlay);
    return overlay;
  }

  function renderAllMarkers() {
    ensureStyles();
    document.querySelectorAll(".jump-marker-overlay").forEach((el) => el.remove());
    const markers = getMarkers();
    markers.forEach((pair) => {
      createOverlay(pair, "source", pair.source);
      createOverlay(pair, "target", pair.target);
    });
  }

  function handleOverlayClick(pair, role) {
    if (state.viewer?.editMode) {
      const autoAdvance = role === "source" && !isPoint(pair.target);
      startPlacement(pair.id, role, { autoAdvance });
      return;
    }
    if (role === "source" && isComplete(pair)) {
      jumpFromPair(pair);
    } else if (role === "target") {
      highlightPair(pair.id);
      safeUpdateStatus(`${pair.label}: Ziel bei Seite ${pair.target?.pageNumber ?? "?"}`);
    }
  }

  function highlightPair(pairId) {
    document.querySelectorAll(`.jump-marker-overlay[data-pair-id="${pairId}"]`).forEach((overlay) => {
      overlay.classList.add("is-highlighted");
      setTimeout(() => overlay.classList.remove("is-highlighted"), 1800);
    });
    uiState.focusedPairId = pairId;
    renderPanel();
  }

  function scrollToPoint(point) {
    const viewer = getViewer();
    const pageEl = getPageElement(point.pageNumber);
    if (!viewer || !pageEl) return;
    const target = pageEl.offsetTop + (pageEl.offsetHeight * (point.y / 100)) - viewer.clientHeight * 0.25;
    viewer.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }

  function jumpFromPair(pair) {
    if (!isComplete(pair)) return;
    scrollToPoint(pair.target);
    highlightPair(pair.id);
    safeUpdateStatus(`${pair.label}: Sprung zum Ziel ausgelöst.`);
  }

  function openCreateModal() {
    const backdrop = document.createElement("div");
    backdrop.className = "jump-marker-modal-backdrop";
    backdrop.innerHTML = `
      <div class="jump-marker-modal" role="dialog" aria-modal="true">
        <h3>Neuer Sprung</h3>
        <form>
          <label for="jumpMarkerNewLabel">Titel</label>
          <input id="jumpMarkerNewLabel" name="label" type="text" value="Sprung ${getMarkers().length + 1}" maxlength="40" autocomplete="off" required>
          <div class="actions">
            <button type="button" class="btn-secondary" data-role="cancel">Abbrechen</button>
            <button type="submit" class="btn-primary">Absprung festlegen</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(backdrop);
    const form = backdrop.querySelector("form");
    const input = form.querySelector("input[name='label']");
    input.focus();
    input.select();
    const close = () => backdrop.remove();
    form.querySelector('[data-role="cancel"]').addEventListener("click", () => {
      close();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const label = input.value.trim() || `Sprung ${getMarkers().length + 1}`;
      close();
      createDraftPair(label);
    });
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close();
    });
  }

  function createDraftPair(label) {
    const pair = {
      id: `jump-${Date.now()}`,
      label,
      source: null,
      target: null
    };
    const markers = getMarkers();
    markers.push(pair);
    renderPanel();
    startPlacement(pair.id, "source", { autoAdvance: true });
  }

  function openRenameModal(pair) {
    const backdrop = document.createElement("div");
    backdrop.className = "jump-marker-modal-backdrop";
    backdrop.innerHTML = `
      <div class="jump-marker-modal" role="dialog" aria-modal="true">
        <h3>Sprung umbenennen</h3>
        <form>
          <label for="jumpMarkerRename">Titel</label>
          <input id="jumpMarkerRename" name="label" type="text" value="${pair.label}" maxlength="40" autocomplete="off" required>
          <div class="actions">
            <button type="button" class="btn-secondary" data-role="cancel">Abbrechen</button>
            <button type="submit" class="btn-primary">OK / Speichern</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(backdrop);
    const form = backdrop.querySelector("form");
    const input = form.querySelector("input[name='label']");
    input.focus();
    input.select();
    const close = () => backdrop.remove();
    form.querySelector('[data-role="cancel"]').addEventListener("click", () => close());
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = input.value.trim() || pair.label;
      pair.label = value;
      close();
      renderPanel();
      renderAllMarkers();
      await saveJumpMarkers(isComplete(pair) ? "Titel gespeichert" : null);
    });
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close();
    });
  }

  function deletePair(pairId) {
    const markers = getMarkers();
    const idx = markers.findIndex((p) => p.id === pairId);
    if (idx !== -1) {
      markers.splice(idx, 1);
      if (uiState.placement?.pairId === pairId) {
        cancelPlacement({ keepDraft: true });
      }
      renderPanel();
      renderAllMarkers();
    }
  }

  function mergeSanitized(sanitized, original) {
    const order = original.map((p) => p.id);
    const sanitizedMap = new Map(sanitized.map((p) => [p.id, p]));
    const drafts = original.filter((p) => !isComplete(p));
    const merged = [];
    order.forEach((id) => {
      if (sanitizedMap.has(id)) {
        merged.push(sanitizedMap.get(id));
      } else {
        const draft = drafts.find((p) => p.id === id);
        if (draft) merged.push(draft);
      }
    });
    sanitized.forEach((pair) => {
      if (!order.includes(pair.id)) {
        merged.push(pair);
      }
    });
    return merged;
  }

  async function saveJumpMarkers(message) {
    if (!state.viewer?.fileName) return;
    const markers = getMarkers();
    const payload = markers.map((pair) => ({
      id: pair.id,
      label: pair.label,
      source: isPoint(pair.source)
        ? {
            pageNumber: pair.source.pageNumber,
            x: clampPercent(pair.source.x),
            y: clampPercent(pair.source.y)
          }
        : null,
      target: isPoint(pair.target)
        ? {
            pageNumber: pair.target.pageNumber,
            x: clampPercent(pair.target.x),
            y: clampPercent(pair.target.y)
          }
        : null
    }));
    try {
      const response = await fetch("/api/prefs/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: state.viewer.fileName, jumpMarkers: payload })
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      if (Array.isArray(data.jumpMarkers)) {
        state.viewer.jumpMarkers = mergeSanitized(data.jumpMarkers, markers);
      }
      if (message) {
        setPanelHint(message, "success");
        safeUpdateStatus(message);
      }
    } catch (err) {
      console.error("Sprungmarkierungen speichern fehlgeschlagen", err);
      setPanelHint("Speichern fehlgeschlagen. Bitte erneut versuchen.", "warn");
      alert("Sprungmarkierungen konnten nicht gespeichert werden.");
    }
    renderPanel();
    renderAllMarkers();
  }

  function toggleEditMode() {
    if (!state.viewer) return;
    state.viewer.editMode = !state.viewer.editMode;
    const btn = document.querySelector("#btnEditMarkers");
    if (btn) {
      applyEditButtonAppearance(btn);
    }
    if (!state.viewer.editMode) {
      cancelPlacement({ keepDraft: true });
      setPanelHint("Edit-Modus beendet.");
    } else {
      setPanelHint(getMarkers().length ? "Wähle eine Sprungmarke zum Bearbeiten." : "Lege zuerst einen Absprung an.", "info");
    }
    setPanelVisibility(state.viewer.editMode);
    renderPanel();
    renderAllMarkers();
  }

  function handleGlobalKeydown(event) {
    if (event.key === "Escape" && state.viewer?.editMode) {
      if (uiState.placement) {
        cancelPlacement({ userTriggered: true });
        event.preventDefault();
        return;
      }
      toggleEditMode();
      event.preventDefault();
    }
  }

  function init() {
    ensureStyles();
    ensureStateShape();
    buildPanel();
    if (!uiState.initialized) {
      window.addEventListener("keydown", handleGlobalKeydown);
      uiState.initialized = true;
    }

    if (!tryConnectViewer()) {
      bindEditButton(false);
      if (uiState.connectTimer) {
        clearInterval(uiState.connectTimer);
        uiState.connectTimer = null;
      }
      let attempts = 0;
      uiState.connectTimer = setInterval(() => {
        attempts += 1;
        if (tryConnectViewer() || attempts > 80) {
          clearInterval(uiState.connectTimer);
          uiState.connectTimer = null;
        }
      }, 150);
    } else {
      if (uiState.connectTimer) {
        clearInterval(uiState.connectTimer);
        uiState.connectTimer = null;
      }
    }
  }

  window.JumpMarkers = {
    init,
    toggleEditMode,
    renderAllMarkers,
    jumpTo(id) {
      const pair = getMarkers().find((p) => p.id === id);
      if (pair) jumpFromPair(pair);
    }
  };
})();
