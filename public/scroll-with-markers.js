/**
 * Enhanced Auto-Scroll mit Sprungmarkierungen-Unterstützung
 * 
 * Dieses Modul erweitert die Auto-Scroll-Funktionalität um:
 * - Seitenbasiertes Scrolling statt kontinuierliches Pixel-Scrolling
 * - Automatische Sprünge basierend auf Jump Markers
 * - Wiederholungszähler pro Tag
 */

// Globaler State für Scroll-Sequenz
let scrollState = {
  sequence: [],       // Array von Seitenzahlen in der richtigen Reihenfolge
  currentIndex: 0,    // Index in der Sequenz
  pageScrollProgress: 0, // Progress innerhalb der aktuellen Seite (0-1)
};

function safeStopAutoScroll() {
  if (typeof window === 'undefined') return;
  if (typeof window.stopAutoScroll === 'function') {
    window.stopAutoScroll();
    return;
  }
  if (window.state?.viewer) {
    window.state.viewer.autoScroll.running = false;
  }
}

function safeRefreshPlayPauseUI() {
  if (typeof window === 'undefined') return;
  if (typeof window.refreshPlayPauseUI === 'function') {
    window.refreshPlayPauseUI();
  }
}

function safeUpdateStatus(message) {
  if (typeof window !== 'undefined' && typeof window.updateStatus === 'function') {
    window.updateStatus(message);
    return;
  }
  const statusEl = document.querySelector('#status');
  if (statusEl) {
    statusEl.textContent = message || '';
  } else if (message) {
    console.log('[ScrollWithMarkers]', message);
  }
}

/**
 * Berechnet die Scroll-Höhe für eine bestimmte Seite
 */
function getPageScrollPosition(pageNum) {
  const pageEl = document.querySelector(`[data-page="${pageNum}"]`);
  if (!pageEl) return null;
  
  const viewer = document.querySelector('#viewer');
  if (!viewer) return null;
  
  // Absolute Position der Seite
  const pageTop = pageEl.offsetTop;
  const pageHeight = pageEl.offsetHeight;
  
  return {
    start: pageTop,
    end: pageTop + pageHeight,
    height: pageHeight
  };
}

/**
 * Berechnet die vollständige Scroll-Sequenz mit Sprungmarkierungen
 */
function computeScrollSequence() {
  if (typeof window.JumpMarkers !== 'undefined' && typeof window.JumpMarkers.buildScrollSequence === 'function') {
    return window.JumpMarkers.buildScrollSequence();
  }
  
  // Fallback: Normale Sequenz ohne Sprünge
  return Array.from({ length: state.viewer.numPages || 1 }, (_, i) => i + 1);
}

/**
 * Initialisiert den Sequenz-basierten Scroll
 */
function initializeScrollSequence() {
  scrollState.sequence = computeScrollSequence();
  scrollState.currentIndex = 0;
  scrollState.pageScrollProgress = 0;
  
  console.log('Scroll-Sequenz:', scrollState.sequence);
  
  // Scrolle zur ersten Seite
  const firstPage = scrollState.sequence[0];
  if (firstPage) {
    const pos = getPageScrollPosition(firstPage);
    if (pos) {
      const viewer = document.querySelector('#viewer');
      if (viewer) {
        viewer.scrollTop = pos.start;
      }
    }
  }
}

/**
 * Berechnet die Geschwindigkeit basierend auf der Sequenz
 */
function computeSequenceSpeed() {
  const secsPerPage = state.viewer.secsPerPage || 45;
  const sequence = scrollState.sequence;
  
  if (!sequence.length) {
    state.viewer.autoScroll.speedPxPerSec = 0;
    return;
  }
  
  // Gesamthöhe über alle Seiten in der Sequenz berechnen
  let totalHeight = 0;
  sequence.forEach(pageNum => {
    const pos = getPageScrollPosition(pageNum);
    if (pos) {
      totalHeight += pos.height;
    }
  });
  
  const totalSecs = secsPerPage * sequence.length;
  state.viewer.autoScroll.speedPxPerSec = totalSecs > 0 ? totalHeight / totalSecs : 0;
}

/**
 * Erweiterte Tick-Funktion für sequenzbasiertes Scrolling
 */
function tickAutoScrollWithMarkers(ts) {
  if (!state.viewer.autoScroll.running) return;
  
  const viewer = document.querySelector('#viewer');
  if (!viewer) {
    safeStopAutoScroll();
    safeRefreshPlayPauseUI();
    return;
  }
  
  const S = state.viewer.autoScroll;
  
  // User-Interaktion berücksichtigen
  if (S.userAdjusting || (S.userActiveUntil && ts < S.userActiveUntil)) {
    S.lastTs = ts;
    requestAnimationFrame(tickAutoScrollWithMarkers);
    return;
  }
  
  // Delta-Zeit berechnen
  const dt = (ts - S.lastTs) / 1000;
  S.lastTs = ts;
  
  // Geschwindigkeit neu berechnen wenn nötig
  if (S.needsRecalc || S.speedPxPerSec <= 0.01) {
    computeSequenceSpeed();
    S.needsRecalc = false;
  }
  
  const maxScrollTop = Math.max(0, viewer.scrollHeight - viewer.clientHeight);
  if (maxScrollTop <= 1) {
    // Warte auf Inhalte
    S.needsRecalc = true;
    requestAnimationFrame(tickAutoScrollWithMarkers);
    return;
  }
  
  // Aktuelle Seite aus Sequenz
  if (scrollState.currentIndex >= scrollState.sequence.length) {
    // Sequenz abgeschlossen
    safeStopAutoScroll();
    safeRefreshPlayPauseUI();
    safeUpdateStatus('Ende der Sequenz erreicht');
    return;
  }
  
  const currentPageNum = scrollState.sequence[scrollState.currentIndex];
  const pagePos = getPageScrollPosition(currentPageNum);
  
  if (!pagePos) {
    // Seite noch nicht geladen, warte
    S.needsRecalc = true;
    requestAnimationFrame(tickAutoScrollWithMarkers);
    return;
  }
  
  // Scrolle innerhalb der aktuellen Seite
  const pixelsPerSec = S.speedPxPerSec;
  const delta = pixelsPerSec * dt;
  
  // Aktuelle Position innerhalb der Seite
  const pageStart = pagePos.start;
  const pageEnd = pagePos.end;
  const pageHeight = pagePos.height;
  
  // Berechne neue Scroll-Position
  let newScrollTop = viewer.scrollTop + delta;
  
  // Prüfe ob wir diese Seite abgeschlossen haben
  if (newScrollTop >= pageEnd) {
    // Zur nächsten Seite in der Sequenz wechseln
    scrollState.currentIndex++;
    scrollState.pageScrollProgress = 0;
    
    if (scrollState.currentIndex >= scrollState.sequence.length) {
      // Sequenz abgeschlossen
      viewer.scrollTop = maxScrollTop;
      safeStopAutoScroll();
      safeRefreshPlayPauseUI();
      safeUpdateStatus('Ende der Sequenz erreicht');
      return;
    }
    
    // Springe zur nächsten Seite
    const nextPageNum = scrollState.sequence[scrollState.currentIndex];
    const nextPagePos = getPageScrollPosition(nextPageNum);
    
    if (nextPagePos) {
      S.ignoreScrollUntil = performance.now() + 100;
      viewer.scrollTop = nextPagePos.start;
      newScrollTop = nextPagePos.start;
      
      // Status update für Sprünge
      const prevPageNum = scrollState.sequence[scrollState.currentIndex - 1];
      if (Math.abs(nextPageNum - prevPageNum) > 1) {
        safeUpdateStatus(`↺ Sprung: Seite ${prevPageNum} → Seite ${nextPageNum}`);
      }
    }
  } else {
    // Normale Scroll-Bewegung
    S.ignoreScrollUntil = performance.now() + 50;
    viewer.scrollTop = Math.min(newScrollTop, maxScrollTop);
  }
  
  requestAnimationFrame(tickAutoScrollWithMarkers);
}

/**
 * Startet den erweiterten Auto-Scroll
 */
async function startAutoScrollWithMarkers() {
  const viewerEl = document.querySelector('#viewer');
  if (!viewerEl) return;
  if (state.viewer.autoScroll.running || state.viewer.autoScroll.pending) return;
  
  state.viewer.autoScroll.pending = true;
  state.viewer.autoScroll.running = true;
  state.viewer.autoScroll.lastTs = performance.now();
  state.viewer.autoScroll.needsRecalc = true;
  state.viewer.autoScroll.pos = viewerEl.scrollTop || 0;
  
  // iOS Kick
  try {
    viewerEl.scrollTop = Math.min(1, viewerEl.scrollHeight - viewerEl.clientHeight);
  } catch {}
  
  try {
    if (typeof ensureFirstPagesRendered === 'function') {
      await ensureFirstPagesRendered();
    }
  } finally {
    state.viewer.autoScroll.pending = false;
  }
  
  // Initialisiere Sequenz (nachdem Seiten verfügbar sind)
  initializeScrollSequence();
  
  computeSequenceSpeed();
  
  const hasMarkers = (state.viewer.jumpMarkers || []).length > 0;
  safeUpdateStatus(`Auto-Scroll: läuft${hasMarkers ? ' (mit Sprungmarkierungen)' : ''}`);
  safeRefreshPlayPauseUI();
  
  requestAnimationFrame(tickAutoScrollWithMarkers);
}

// Export
if (typeof window !== 'undefined') {
  window.ScrollWithMarkers = {
    start: startAutoScrollWithMarkers,
    computeSequence: computeScrollSequence,
    initSequence: initializeScrollSequence
  };
}
