/**
 * controls.js
 *
 * Manages the bottom controls bar:
 *   - Record / Stop button (primary action)
 *   - Translate toggle button
 *   - Wires to speech service via eventBus
 *
 * Button states follow the app state machine:
 *   idle → [tap Record] → connecting → recording → [tap Stop] → stopping → idle
 */

import { eventBus }                      from '../utils/eventBus.js';
import { startRecognition, stopRecognition } from '../services/speechService.js';

/** @type {'idle'|'connecting'|'recording'|'stopping'} */
let _recordState   = 'idle';
let _translateOn   = false;

/**
 * Initialise controls.
 * @param {{ onTranslateToggle: (on: boolean) => void }} callbacks
 */
export function initControls({ onTranslateToggle }) {
  const btnRecord    = document.getElementById('btn-record');
  const btnRecLabel  = document.getElementById('btn-record-label');
  const iconRecord   = btnRecord.querySelector('.icon-record');
  const iconStop     = btnRecord.querySelector('.icon-stop');
  const iconLoading  = btnRecord.querySelector('.icon-loading');
  const btnTranslate = document.getElementById('btn-translate');

  // ── Record button ────────────────────────────────────────────────────────
  btnRecord.addEventListener('click', async () => {
    console.log('[DIAG] Record button clicked, state:', _recordState);
    if (_recordState === 'idle' || _recordState === 'stopped') {
      await _startRecording();
    } else if (_recordState === 'recording') {
      _stopRecording();
    } else {
      console.log('[DIAG] Click ignored — state is', _recordState);
    }
  });

  async function _startRecording() {
    console.log('[DIAG] _startRecording() called');
    console.log('[DIAG] window.SpeechSDK available:', typeof window.SpeechSDK);
    _setRecordState('connecting');
    eventBus.emit('app:connecting');
    try {
      console.log('[DIAG] calling startRecognition()...');
      await startRecognition();
      // State updates via recognition:started event
    } catch (err) {
      _setRecordState('idle');
      let msg = err.message || 'Could not start recording.';
      if (/Permission|NotAllowed|NotFound/i.test(msg)) {
        msg = 'Microphone access denied. Please allow microphone in browser settings.';
      }
      eventBus.emit('app:error', { message: msg });
    }
  }

  function _stopRecording() {
    _setRecordState('stopping');
    stopRecognition();
  }

  // ── Translate button ─────────────────────────────────────────────────────
  btnTranslate.addEventListener('click', () => {
    console.log('[DIAG] Translate button clicked, translateOn will be:', !_translateOn);
    _translateOn = !_translateOn;
    btnTranslate.setAttribute('aria-pressed', String(_translateOn));
    btnTranslate.classList.toggle('btn--translate-active', _translateOn);
    onTranslateToggle(_translateOn);
  });

  // ── Event bus ────────────────────────────────────────────────────────────

  eventBus.on('recognition:started', () => {
    _setRecordState('recording');
  });

  eventBus.on('recognition:stopped', () => {
    _setRecordState('idle');
  });

  eventBus.on('recognition:reconnecting', () => {
    _setRecordState('connecting');
  });

  eventBus.on('recognition:error', () => {
    _setRecordState('idle');
  });

  // ── State → UI ────────────────────────────────────────────────────────────

  function _setRecordState(state) {
    _recordState = state;
    btnRecord.dataset.state = state;
    btnRecord.disabled = state === 'connecting' || state === 'stopping';

    switch (state) {
      case 'idle':
      case 'stopped':
        iconRecord.style.display  = '';
        iconStop.style.display    = 'none';
        iconLoading.style.display = 'none';
        btnRecLabel.textContent   = 'Record';
        btnRecord.setAttribute('aria-label', 'Start recording');
        break;
      case 'connecting':
        iconRecord.style.display  = 'none';
        iconStop.style.display    = 'none';
        iconLoading.style.display = '';
        btnRecLabel.textContent   = 'Connecting';
        btnRecord.setAttribute('aria-label', 'Connecting…');
        break;
      case 'recording':
        iconRecord.style.display  = 'none';
        iconStop.style.display    = '';
        iconLoading.style.display = 'none';
        btnRecLabel.textContent   = 'Stop';
        btnRecord.setAttribute('aria-label', 'Stop recording');
        break;
      case 'stopping':
        iconRecord.style.display  = 'none';
        iconStop.style.display    = '';
        iconLoading.style.display = 'none';
        btnRecLabel.textContent   = 'Stopping';
        btnRecord.setAttribute('aria-label', 'Stopping…');
        break;
    }
  }
}

/** Returns true if translation is currently toggled on. */
export function isTranslateOn() { return _translateOn; }
