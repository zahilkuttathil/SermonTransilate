/**
 * translationPane.js
 *
 * Manages the translation pane:
 *   - Slides in when the user taps "Translate"
 *   - Virtual scroll over cached translation segments
 *   - On-demand translation via translationService (checks IndexedDB cache first)
 *   - ChunkBatcher queues new live segments for background translation
 *   - Close button collapses the pane
 */

import { eventBus }           from '../utils/eventBus.js';
import { VirtualScroller }    from '../utils/virtualScroller.js';
import { ChunkBatcher }       from '../utils/chunkBatcher.js';
import { translateSegments }  from '../services/translationService.js';
import { getTranslationPage, getSegmentsMeta } from '../store/db.js';

let _scroller       = null;
let _sessionId      = null;
let _targetLang     = 'en';
let _targetLabel    = 'English';
let _isVisible      = false;
let _batcher        = null;
let _segmentTotal   = 0;    // mirrors transcriptPane total

/**
 * Initialise the translation pane. Call once at app start.
 * @param {number} sessionId
 * @param {string} targetLang  BCP-47 code, e.g. "es"
 * @param {string} targetLabel Human-readable label
 */
export function initTranslationPane(sessionId, targetLang, targetLabel) {
  _sessionId   = sessionId;
  _targetLang  = targetLang;
  _targetLabel = targetLabel;

  const pane         = document.getElementById('translation-pane');
  const scroll       = document.getElementById('translation-scroll');
  const list         = document.getElementById('translation-list');
  const spacerTop    = document.getElementById('translation-spacer-top');
  const spacerBottom = document.getElementById('translation-spacer-bottom');
  const emptyState   = document.getElementById('translation-empty');
  const langLabel    = document.getElementById('translation-lang-label');
  const loadingEl    = document.getElementById('translation-loading');
  const btnClose     = document.getElementById('btn-close-translation');

  langLabel.textContent = _targetLabel;

  // Destroy previous scroller
  _scroller?.destroy();

  _scroller = new VirtualScroller({
    container:   scroll,
    list,
    spacerTop,
    spacerBottom,
    fetchPage:   (offset, size) => _fetchTranslationPage(offset, size),
    renderItem:  _renderTranslationItem,
    windowSize:  8,
    itemHeight:  76,
  });

  // Batcher: collect newly arrived segments and translate them in groups
  _batcher?.cancel();
  _batcher = new ChunkBatcher(async (segIds) => {
    if (!_isVisible) return;
    await _translateAndRefresh(segIds);
  }, 800);

  // ── Close button ─────────────────────────────────────────────────────────
  btnClose.addEventListener('click', hideTranslationPane);

  // ── Language changed ─────────────────────────────────────────────────────
  eventBus.on('lang:changed', ({ code, label }) => {
    _targetLang  = code;
    _targetLabel = label;
    langLabel.textContent = label;
    // Invalidate view — translations for new language may not be cached yet
    _scroller.reset();
    if (_isVisible && _segmentTotal > 0) {
      _scroller.onNewItem(_segmentTotal);
      // Translate visible window
      _translateVisibleWindow();
    }
  });

  // ── New live segment arrived ──────────────────────────────────────────────
  eventBus.on('transcript:final', ({ total, segmentId }) => {
    _segmentTotal = total;
    if (_isVisible) {
      _scroller.onNewItem(total);
    }
    // Queue segment for background translation
    if (segmentId !== undefined) {
      _batcher.add(segmentId);
    }
  });

  // ── Session reset ─────────────────────────────────────────────────────────
  eventBus.on('session:new', ({ sessionId: newId }) => {
    _sessionId    = newId;
    _segmentTotal = 0;
    _scroller.reset();
    emptyState.classList.remove('pane__empty--hidden');
  });

  // Helper refs for show/hide
  pane._emptyEl   = emptyState;
  pane._loadingEl = loadingEl;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Show the translation pane and translate currently visible segments.
 * @param {number} segmentTotal  - current total segments
 */
export async function showTranslationPane(segmentTotal) {
  _segmentTotal = segmentTotal;
  _isVisible    = true;

  const pane     = document.getElementById('translation-pane');
  const langLabel = document.getElementById('translation-lang-label');
  langLabel.textContent = _targetLabel;

  pane.classList.remove('pane--collapsed');
  pane.setAttribute('aria-hidden', 'false');

  const contentArea = document.getElementById('content-area');
  contentArea.classList.add('content-area--dual');

  if (segmentTotal > 0) {
    pane._emptyEl.classList.add('pane__empty--hidden');
    await _scroller.onNewItem(segmentTotal);
    await _translateVisibleWindow();
  }
}

/** Hide/collapse the translation pane. */
export function hideTranslationPane() {
  _isVisible = false;

  const pane = document.getElementById('translation-pane');
  pane.classList.add('pane--collapsed');
  pane.setAttribute('aria-hidden', 'true');

  const contentArea = document.getElementById('content-area');
  contentArea.classList.remove('content-area--dual');

  const btnTranslate = document.getElementById('btn-translate');
  btnTranslate.setAttribute('aria-pressed', 'false');
  btnTranslate.classList.remove('btn--translate-active');

  _batcher?.cancel();
}

/** Update the session being displayed (after session history restore). */
export function setTranslationSession(sessionId, total) {
  _sessionId    = sessionId;
  _segmentTotal = total;
  _scroller?.reset();
  if (_isVisible && total > 0) {
    _scroller.onNewItem(total);
    _translateVisibleWindow();
  }
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function _fetchTranslationPage(offset, size) {
  return getTranslationPage(_sessionId, _targetLang, offset, size);
}

async function _translateVisibleWindow() {
  const loadingEl = document.getElementById('translation-loading');
  const pane      = document.getElementById('translation-pane');

  // Find segments in current virtual window that are not yet translated
  const windowStart = _scroller._windowStart ?? 0;
  const items = await getTranslationPage(_sessionId, _targetLang, windowStart, 8);
  const uncached = items
    .filter(item => item.text === null)
    .map(item => ({ id: item.segmentId, text: item.originalText }));

  if (!uncached.length) return;

  loadingEl.classList.remove('translation-loading--hidden');
  try {
    await translateSegments(uncached, _targetLang);
    await _scroller.refresh();
    if (pane._emptyEl) pane._emptyEl.classList.add('pane__empty--hidden');
  } catch (err) {
    eventBus.emit('app:info', {
      message: 'Translation temporarily unavailable. Will retry.',
      type: 'warning',
      duration: 4000,
    });
  } finally {
    loadingEl.classList.add('translation-loading--hidden');
  }
}

async function _translateAndRefresh(segIds) {
  // Look up the full segment text for given IDs
  const windowStart = _scroller?._windowStart ?? 0;
  const items = await getTranslationPage(_sessionId, _targetLang, windowStart, 8);
  const needed = items
    .filter(item => segIds.includes(item.segmentId) && item.text === null)
    .map(item => ({ id: item.segmentId, text: item.originalText }));

  if (!needed.length) return;

  try {
    await translateSegments(needed, _targetLang);
    if (_isVisible) await _scroller.refresh();
  } catch {
    // Silent — will retry next time visible window loads
  }
}

// ── Renderer ─────────────────────────────────────────────────────────────────

function _renderTranslationItem(item) {
  const el = document.createElement('div');
  el.className = 'segment segment--translation';
  el.dataset.segmentId = item.segmentId;

  const badge = document.createElement('span');
  badge.className   = 'segment__badge segment__badge--translated';
  badge.textContent = _targetLabel.split('(')[0].trim().slice(0, 4).toUpperCase();

  const text = document.createElement('p');
  text.className = 'segment__text';

  if (item.text) {
    text.textContent = item.text;    // Always textContent — no innerHTML (XSS)
  } else {
    text.innerHTML = '<span class="segment__pending">Translating…</span>';
  }

  el.append(badge, text);
  return el;
}

// holds current target lang/label for renderer
Object.defineProperty(_renderTranslationItem, 'targetLabel', {
  get: () => _targetLabel,
});
