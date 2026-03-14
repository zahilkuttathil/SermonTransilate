/**
 * main.js — PreachListen App Entry Point
 *
 * Orchestrates the full application lifecycle:
 *   1. Service Worker registration (PWA)
 *   2. IndexedDB initialisation & old-session pruning
 *   3. Session creation
 *   4. UI module initialisation (toolbar, controls, langPicker, panes)
 *   5. Event bus wiring:
 *        speech:recognized  → persist to IndexedDB → emit transcript:final (enriched)
 *        recognition:stopped → finalise session
 *   6. Session history modal
 *
 * Event contract:
 *   'speech:recognized'  (from speechService) — raw: { text, language, timestamp }
 *   'transcript:final'   (from main.js)       — enriched: { text, language, timestamp, total, segmentId }
 *   'transcript:interim' (from speechService) — { text, language }
 */

import { eventBus }           from './utils/eventBus.js';
import { pruneOldSessions, createSession, completeSession,
         addSegment, getSegmentCount, getAllSessions,
         deleteSession, getSession } from './store/db.js';
import { initToolbar }        from './ui/toolbar.js';
import { initControls }       from './ui/controls.js';
import { initLangPicker, getSelectedLangCode, getSelectedLangLabel } from './ui/langPicker.js';
import { initTranscriptPane, restoreTranscriptPane } from './ui/transcriptPane.js';
import { initTranslationPane, showTranslationPane,
         hideTranslationPane, setTranslationSession } from './ui/translationPane.js';

// ── App state ────────────────────────────────────────────────────────────────

let _sessionId    = null;
let _segmentSeq   = 0;   // sequenceNum of the NEXT segment to be written
let _segmentTotal = 0;   // count of segments persisted in this session

// ── Boot ─────────────────────────────────────────────────────────────────────

(async function boot() {
  // 1. Register Service Worker
  _registerSW();

  // 2. Prune old sessions (> 30 days) — do not block UI
  pruneOldSessions(30).catch(err =>
    console.warn('[main] pruneOldSessions:', err)
  );

  // 3. Create a fresh session for this page load
  try {
    _sessionId = await createSession();
  } catch (err) {
    console.error('[main] Could not create session:', err);
    eventBus.emit('app:error', { message: 'Storage unavailable. Try refreshing.' });
    return;
  }

  const targetLang  = getSelectedLangCode()  ?? 'en';
  const targetLabel = getSelectedLangLabel() ?? 'English';

  // 4. Initialise UI modules
  //    (their eventBus handlers are registered inside these calls)
  initToolbar();
  initLangPicker();
  initTranscriptPane(_sessionId);
  initTranslationPane(_sessionId, targetLang, targetLabel);
  initControls({
    onTranslateToggle: async (on) => {
      if (on) {
        await showTranslationPane(_segmentTotal);
      } else {
        hideTranslationPane();
      }
    },
  });

  // 5a. Intercept raw speech events — persist to DB, then emit enriched transcript:final
  eventBus.on('speech:recognized', async (data) => {
    if (!_sessionId) return;
    try {
      const segmentId = await addSegment(_sessionId, _segmentSeq, {
        text:      data.text,
        language:  data.language,
        timestamp: data.timestamp,
      });
      _segmentSeq++;
      _segmentTotal++;

      // Emit enriched event — panes and toolbar consume this
      eventBus.emit('transcript:final', {
        text:      data.text,
        language:  data.language,
        timestamp: data.timestamp,
        total:     _segmentTotal,
        segmentId,
      });
    } catch (err) {
      console.error('[main] addSegment failed:', err);
      eventBus.emit('app:error', { message: 'Failed to save transcript segment.' });
    }
  });

  // 5b. Finalise session when recording stops
  eventBus.on('recognition:stopped', async () => {
    if (_sessionId) {
      await completeSession(_sessionId).catch(console.warn);
    }
  });

  // 5c. Reset counters when a history session is loaded
  eventBus.on('session:new', ({ total }) => {
    _segmentTotal = total ?? 0;
    _segmentSeq   = _segmentTotal;
  });

  // 6. History modal
  _initHistoryModal();

  console.info('[PreachListen] Ready. Session ID:', _sessionId);
})();

// ── Service Worker ────────────────────────────────────────────────────────────

function _registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js')
    .then(reg => console.info('[SW] Registered, scope:', reg.scope))
    .catch(err => console.warn('[SW] Registration failed:', err));
}

// ── History Modal ─────────────────────────────────────────────────────────────

function _initHistoryModal() {
  const btnHistory    = document.getElementById('btn-history');
  const backdrop      = document.getElementById('modal-backdrop');
  const btnCloseHist  = document.getElementById('btn-close-history');
  const historyList   = document.getElementById('history-list');

  async function openModal() {
    historyList.innerHTML = '';
    const sessions = await getAllSessions();

    if (!sessions.length) {
      historyList.innerHTML = '<p class="modal__empty">No past sessions yet.</p>';
    } else {
      for (const s of sessions) {
        const count = await getSegmentCount(s.id);
        const item  = _buildHistoryItem(s, count);
        historyList.appendChild(item);
      }
    }

    backdrop.classList.remove('modal-backdrop--hidden');
    backdrop.setAttribute('aria-hidden', 'false');
    btnCloseHist.focus();
  }

  function closeModal() {
    backdrop.classList.add('modal-backdrop--hidden');
    backdrop.setAttribute('aria-hidden', 'true');
  }

  btnHistory.addEventListener('click', openModal);
  btnCloseHist.addEventListener('click', closeModal);

  // Click outside modal content closes it
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) closeModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });
}

function _buildHistoryItem(session, segmentCount) {
  const el = document.createElement('div');
  el.className = 'history-item';

  const date    = new Date(session.createdAt);
  const dateStr = date.toLocaleDateString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  });
  const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const lang    = session.detectedLanguage
    ? session.detectedLanguage.split('-')[0].toUpperCase()
    : '?';

  // Build DOM safely — no innerHTML with user data
  const info = document.createElement('div');
  info.className = 'history-item__info';

  const dateSpan = document.createElement('span');
  dateSpan.className = 'history-item__date';
  dateSpan.textContent = `${dateStr} ${timeStr}`;

  const metaSpan = document.createElement('span');
  metaSpan.className = 'history-item__meta';
  metaSpan.textContent = `${segmentCount} segments \u00b7 ${lang}`;

  info.append(dateSpan, metaSpan);

  const actions = document.createElement('div');
  actions.className = 'history-item__actions';

  const btnView = document.createElement('button');
  btnView.className = 'btn btn--text history-item__load';
  btnView.textContent = 'View';
  btnView.setAttribute('aria-label', `View session from ${dateStr}`);

  const btnDel = document.createElement('button');
  btnDel.className = 'btn btn--text btn--danger history-item__delete';
  btnDel.textContent = 'Delete';
  btnDel.setAttribute('aria-label', `Delete session from ${dateStr}`);

  actions.append(btnView, btnDel);
  el.append(info, actions);

  btnView.addEventListener('click', async () => {
    await _loadHistorySession(session.id);
    const backdrop = document.getElementById('modal-backdrop');
    backdrop.classList.add('modal-backdrop--hidden');
    backdrop.setAttribute('aria-hidden', 'true');
  });

  btnDel.addEventListener('click', async () => {
    await deleteSession(session.id);
    el.remove();
    const list = document.getElementById('history-list');
    if (!list.querySelector('.history-item')) {
      const empty = document.createElement('p');
      empty.className = 'modal__empty';
      empty.textContent = 'No past sessions yet.';
      list.replaceChildren(empty);
    }
  });

  return el;
}

async function _loadHistorySession(sessionId) {
  const count = await getSegmentCount(sessionId);

  _sessionId    = sessionId;
  _segmentTotal = count;
  _segmentSeq   = count;  // read-only view, no new segments

  const lang  = getSelectedLangCode()  ?? 'en';
  const label = getSelectedLangLabel() ?? 'English';

  // Re-initialise panes for the historical session (new sessionId-scoped fetchPage)
  initTranscriptPane(sessionId);
  initTranslationPane(sessionId, lang, label);
  await restoreTranscriptPane(count);
  setTranslationSession(sessionId, count);

  // Hide empty states if the session has segments
  if (count > 0) {
    document.getElementById('transcript-empty')?.classList.add('pane__empty--hidden');
    document.getElementById('translation-empty')?.classList.add('pane__empty--hidden');
  }

  // Sync live counters (won't re-init panes since they're already set above)
  eventBus.emit('session:new', { sessionId, total: count });

  eventBus.emit('app:info', {
    message: `Loaded past session — ${count} segment${count !== 1 ? 's' : ''}.`,
    type:    'info',
    duration: 3500,
  });
}
