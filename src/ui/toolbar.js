/**
 * toolbar.js
 *
 * Manages the top toolbar:
 *   - App name / logo
 *   - Detected language badge (updates live as speech is recognized)
 *   - Connection status indicator (idle / connecting / live / error)
 *   - Error/info banner below the toolbar
 */

import { eventBus } from '../utils/eventBus.js';

// Status dot states — drives CSS class and ARIA text
const STATE_LABELS = {
  idle:         'Ready',
  connecting:   'Connecting…',
  live:         'Live',
  reconnecting: 'Reconnecting…',
  stopped:      'Stopped',
  error:        'Error',
};

let _bannerTimeout = null;

/** Initialise toolbar listeners. */
export function initToolbar() {
  const statusDot  = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const detectedEl = document.getElementById('detected-lang');
  const banner     = document.getElementById('banner');
  const bannerText = document.getElementById('banner-text');
  const bannerIcon = document.getElementById('banner-icon');
  const bannerClose = document.getElementById('banner-close');

  function setStatus(state) {
    statusDot.dataset.state = state;
    statusText.textContent = STATE_LABELS[state] ?? state;
  }

  function showBanner(message, type = 'warning', autoDismissMs = 0) {
    bannerIcon.textContent = type === 'error' ? '✕' : type === 'info' ? 'ℹ' : '⚠';
    bannerText.textContent = message;
    banner.className = `banner banner--${type}`;
    banner.setAttribute('aria-hidden', 'false');

    clearTimeout(_bannerTimeout);
    if (autoDismissMs > 0) {
      _bannerTimeout = setTimeout(hideBanner, autoDismissMs);
    }
  }

  function hideBanner() {
    banner.classList.add('banner--hidden');
    banner.setAttribute('aria-hidden', 'true');
  }

  // Close button
  bannerClose.addEventListener('click', hideBanner);

  // ── Event bus listeners ──────────────────────────────────────────────────

  eventBus.on('recognition:started', () => {
    setStatus('live');
    hideBanner();
  });

  eventBus.on('recognition:stopped', () => {
    setStatus('stopped');
    // Auto-reset to idle after 3s
    setTimeout(() => setStatus('idle'), 3000);
  });

  eventBus.on('recognition:reconnecting', () => {
    setStatus('reconnecting');
    showBanner('Connection dropped. Reconnecting…', 'warning');
  });

  eventBus.on('recognition:error', ({ message }) => {
    setStatus('error');
    const friendly = _friendlyError(message);
    showBanner(friendly, 'error');
  });

  eventBus.on('app:connecting', () => {
    setStatus('connecting');
  });

  eventBus.on('app:info', ({ message, type, duration }) => {
    showBanner(message, type ?? 'info', duration ?? 4000);
  });

  eventBus.on('app:error', ({ message }) => {
    setStatus('error');
    showBanner(message, 'error');
  });

  // Update detected language badge from incoming transcript segments
  eventBus.on('transcript:final', ({ language }) => {
    if (language && language !== 'unknown') {
      const shortCode = language.split('-')[0].toUpperCase();
      detectedEl.textContent = shortCode;
      detectedEl.title = `Detected language: ${language}`;
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _friendlyError(raw = '') {
  if (/microphone|audio|getUserMedia/i.test(raw)) {
    return 'Microphone access denied. Please allow microphone in browser settings.';
  }
  if (/auth|token|unauthorized|401/i.test(raw)) {
    return 'Authentication error. Please check your Azure Speech Service configuration.';
  }
  if (/network|websocket|connection/i.test(raw)) {
    return 'Network connection lost. Check your internet connection.';
  }
  if (/quota|rate limit|429/i.test(raw)) {
    return 'Azure rate limit reached. Please wait a moment before resuming.';
  }
  return raw?.length > 120 ? raw.slice(0, 120) + '…' : (raw || 'An unexpected error occurred.');
}
