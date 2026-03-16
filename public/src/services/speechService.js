/**
 * speechService.js
 *
 * Wraps the Azure Cognitive Services Speech SDK (loaded as window.SpeechSDK).
 *
 * Features:
 *  - Continuous speech recognition with automatic language detection (open-range)
 *  - Emits 'transcript:interim' events for live visual feedback (NOT persisted)
 *  - Emits 'speech:recognized' events for confirmed segments (main.js persists them)
 *  - One auto-reconnect attempt on unexpected disconnect
 *  - Token refresh: re-authenticates transparently before the 10-min STS token expires
 */

import { eventBus }                  from '../utils/eventBus.js';
import { getToken, invalidateToken } from './tokenService.js';

// Azure Speech SDK — loaded as UMD script (sets window.SpeechSDK)
console.log('[DIAG] speechService.js evaluating — window.SpeechSDK:', typeof window.SpeechSDK);
const SDK = window.SpeechSDK;
if (!SDK) {
  console.error('[DIAG] FATAL: window.SpeechSDK is undefined. Speech SDK CDN script did not load. Recording will not work.');
}

let _recognizer     = null;
let _tokenRefreshId = null;   // setInterval handle
let _reconnecting   = false;

/** True while recognition is active. */
export let isRecognizing = false;

/**
 * Start continuous speech recognition.
 * Automatically detects the spoken language from 150+ candidates.
 *
 * @throws {Error} if the Speech SDK is not loaded or microphone is denied
 */
export async function startRecognition() {
  if (isRecognizing) return;
  _reconnecting = false;

  const { token, region } = await getToken();

  const speechConfig = SDK.SpeechConfig.fromAuthorizationToken(token, region);
  // High-quality audio: 16 kHz mono PCM — optimal for Speech Service
  speechConfig.setProperty(
    SDK.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, '8000'
  );
  speechConfig.setProperty(
    SDK.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, '1200'
  );

  // Auto Language Identification — open-range (no fixed candidate list required with S0+)
  const autoDetect = SDK.AutoDetectSourceLanguageConfig.fromOpenRange();

  // Default microphone input
  const audioConfig = SDK.AudioConfig.fromDefaultMicrophoneInput();

  // SpeechRecognizer.FromConfig() is required when using AutoDetectSourceLanguageConfig
  _recognizer = SDK.SpeechRecognizer.FromConfig(speechConfig, autoDetect, audioConfig);

  // ── Event: interim result (greyed-out live text) ───────────────────────
  _recognizer.recognizing = (_sender, e) => {
    if (!e.result.text) return;

    const lang = _detectLang(e.result);
    eventBus.emit('transcript:interim', {
      text:     e.result.text,
      language: lang,
    });
  };

  // ── Event: final result (confirmed sentence) ───────────────────────────
  _recognizer.recognized = (_sender, e) => {
    if (e.result.reason !== SDK.ResultReason.RecognizedSpeech) return;
    if (!e.result.text?.trim()) return;

    const lang = _detectLang(e.result);
    // Emit as 'speech:recognized' — main.js will persist to IndexedDB, then
    // re-emit as 'transcript:final' with enriched { total, segmentId } for panes.
    eventBus.emit('speech:recognized', {
      text:      e.result.text.trim(),
      language:  lang,
      timestamp: Date.now(),
    });
  };

  // ── Event: recognition canceled (auth error, network, etc.) ───────────
  _recognizer.canceled = (_sender, e) => {
    console.warn('[SpeechService] Canceled:', e.errorCode, e.errorDetails);

    if (e.reason === SDK.CancellationReason.Error) {
      // Auth token likely expired — invalidate and try once
      if (
        e.errorCode === SDK.CancellationErrorCode.AuthenticationFailure &&
        !_reconnecting
      ) {
        _reconnecting = true;
        invalidateToken();
        _cleanupRecognizer();
        // Give Azure 1.5s before reconnecting with a fresh token
        setTimeout(() => {
          eventBus.emit('recognition:reconnecting');
          startRecognition().catch(err => {
            eventBus.emit('recognition:error', { message: err.message });
          });
        }, 1500);
        return;
      }

      eventBus.emit('recognition:error', { message: e.errorDetails });
    }

    _onStopped();
  };

  // ── Event: session stopped ─────────────────────────────────────────────
  _recognizer.sessionStopped = () => {
    _onStopped();
  };

  // ── Start continuous recognition ───────────────────────────────────────
  await new Promise((resolve, reject) => {
    _recognizer.startContinuousRecognitionAsync(resolve, reject);
  });

  isRecognizing = true;
  eventBus.emit('recognition:started');

  // Schedule proactive token refresh (every 8 minutes)
  _tokenRefreshId = setInterval(_refreshToken, 8 * 60 * 1000);
}

/**
 * Stop recognition gracefully.
 */
export function stopRecognition() {
  if (!_recognizer || !isRecognizing) return;
  _recognizer.stopContinuousRecognitionAsync(
    () => { _cleanupRecognizer(); _onStopped(); },
    err => {
      console.error('[SpeechService] stopContinuousRecognitionAsync error:', err);
      _cleanupRecognizer();
      _onStopped();
    }
  );
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function _detectLang(result) {
  try {
    const raw = result.properties.getProperty(
      SDK.PropertyId.SpeechServiceConnection_AutoDetectSourceLanguageResult
    );
    return raw && raw !== 'Unknown' ? raw : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function _refreshToken() {
  try {
    invalidateToken();
    const { token } = await getToken();
    if (_recognizer) {
      _recognizer.authorizationToken = token;
    }
  } catch (err) {
    console.error('[SpeechService] Token refresh failed:', err);
  }
}

function _cleanupRecognizer() {
  clearInterval(_tokenRefreshId);
  _tokenRefreshId = null;
  try { _recognizer?.close(); } catch { /* ignore */ }
  _recognizer = null;
}

function _onStopped() {
  isRecognizing = false;
  _reconnecting = false;
  eventBus.emit('recognition:stopped');
}
