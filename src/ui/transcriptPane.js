/**
 * transcriptPane.js
 *
 * Manages the live transcript pane:
 *   - Virtual scroll over IndexedDB transcript segments (max 8 DOM nodes)
 *   - Interim (greyed) text bar at bottom for live feedback
 *   - Auto-scroll follows the speaker; pauses if user scrolls up
 *   - Shows empty-state illustration before first segment
 */

import { eventBus }        from '../utils/eventBus.js';
import { VirtualScroller } from '../utils/virtualScroller.js';
import { getSegmentPage }  from '../store/db.js';

let _scroller  = null;
let _sessionId = null;

/**
 * Initialise the transcript pane for a session.
 * @param {number} sessionId
 */
export function initTranscriptPane(sessionId) {
  _sessionId = sessionId;

  const scroll       = document.getElementById('transcript-scroll');
  const list         = document.getElementById('transcript-list');
  const spacerTop    = document.getElementById('transcript-spacer-top');
  const spacerBottom = document.getElementById('transcript-spacer-bottom');
  const emptyState   = document.getElementById('transcript-empty');
  const interimBar   = document.getElementById('interim-bar');
  const langLabel    = document.getElementById('transcript-lang-label');

  // Destroy previous scroller if any (session change)
  _scroller?.destroy();

  _scroller = new VirtualScroller({
    container:   scroll,
    list,
    spacerTop,
    spacerBottom,
    fetchPage:   (offset, size) => getSegmentPage(sessionId, offset, size),
    renderItem:  _renderSegment,
    windowSize:  8,
    itemHeight:  76,
  });

  // ── Interim text ────────────────────────────────────────────────────────
  eventBus.on('transcript:interim', ({ text }) => {
    interimBar.textContent = text;
    interimBar.classList.toggle('interim-bar--visible', !!text);
  });

  // ── Final segment arrived ───────────────────────────────────────────────
  eventBus.on('transcript:final', ({ language, total }) => {
    // Clear interim bar
    interimBar.textContent = '';
    interimBar.classList.remove('interim-bar--visible');

    // Hide empty state after first segment
    if (total >= 1) {
      emptyState.classList.add('pane__empty--hidden');
    }

    // Update detected language label
    if (language && language !== 'unknown') {
      langLabel.textContent = _shortLang(language);
    }

    // Tell virtual scroller a new item arrived
    _scroller.onNewItem(total);
  });

  // ── Session reset ────────────────────────────────────────────────────────
  eventBus.on('session:new', ({ sessionId: newId }) => {
    _sessionId = newId;
    _scroller.reset();
    emptyState.classList.remove('pane__empty--hidden');
    interimBar.textContent = '';
    interimBar.classList.remove('interim-bar--visible');
    langLabel.textContent = '';
  });
}

/**
 * Force the virtual scroller to reload with given total (e.g. after restoring a session).
 * @param {number} total
 */
export async function restoreTranscriptPane(total) {
  if (!_scroller) return;
  await _scroller.onNewItem(total);
}

// ── Segment renderer ─────────────────────────────────────────────────────────

function _renderSegment(seg) {
  const el = document.createElement('div');
  el.className = 'segment segment--transcript';
  el.dataset.segmentId = seg.id;

  // Language badge
  const badge = document.createElement('span');
  badge.className   = 'segment__badge';
  badge.textContent = _shortLang(seg.language);
  badge.title       = seg.language;

  // Text — always textContent, never innerHTML (XSS prevention)
  const text = document.createElement('p');
  text.className   = 'segment__text';
  text.textContent = seg.text;

  // Timestamp (relative, e.g. "0:12")
  const ts = document.createElement('span');
  ts.className   = 'segment__time';
  ts.textContent = seg.timestamp ? _formatMs(seg.timestamp) : '';

  el.append(badge, text, ts);
  return el;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _shortLang(lang = '') {
  return lang.split('-')[0].toUpperCase().slice(0, 4);
}

function _formatMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h  = Math.floor(totalSec / 3600);
  const m  = Math.floor((totalSec % 3600) / 60);
  const s  = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
