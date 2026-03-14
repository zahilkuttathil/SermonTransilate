/**
 * tokenService.js
 *
 * Fetches a short-lived Azure Speech STS authorization token from the secure
 * backend endpoint (/api/speech-token). The token is cached in memory for
 * TOKEN_TTL_MS and automatically invalidated before expiry.
 *
 * The STS token is NEVER stored in localStorage or sessionStorage — it lives
 * only in the JS heap for the lifetime of the current page.
 */

const TOKEN_ENDPOINT = 'https://apim-manna-25cfda35a7aa.azure-api.net/sermon/speech-token';

/** Refresh 1 minute before the 10-minute Azure STS expiry */
const TOKEN_TTL_MS = 9 * 60 * 1000;

/** Max retry attempts on transient failure */
const MAX_RETRIES = 3;

let _cached   = null;   // { token: string, region: string }
let _expiry   = 0;      // timestamp when cache is invalid
let _inflight = null;   // deduplicates concurrent fetch calls

/**
 * Returns a valid { token, region } object.
 * Fetches from the API if not cached or about to expire.
 *
 * Throws if the endpoint is unreachable after retries.
 *
 * @returns {Promise<{ token: string, region: string }>}
 */
export async function getToken() {
  if (_cached && Date.now() < _expiry) return _cached;

  // Deduplicate concurrent requests (e.g. two modules calling simultaneously)
  if (_inflight) return _inflight;

  _inflight = _fetchWithRetry()
    .then(data => {
      _cached  = data;
      _expiry  = Date.now() + TOKEN_TTL_MS;
      _inflight = null;
      return data;
    })
    .catch(err => {
      _inflight = null;
      throw err;
    });

  return _inflight;
}

/** Invalidate the cached token (call after a WebSocket auth error). */
export function invalidateToken() {
  _cached = null;
  _expiry = 0;
}

// ── Internal ────────────────────────────────────────────────────────────────

async function _fetchWithRetry(attempt = 1) {
  try {
    const res = await fetch(TOKEN_ENDPOINT, { method: 'GET', cache: 'no-store' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Token endpoint returned ${res.status}: ${body}`);
    }
    const data = await res.json();
    if (!data.token || !data.region) {
      throw new Error('Token response missing required fields');
    }
    return data;
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      // Exponential back-off: 1s, 2s, 4s …
      await _sleep(2 ** (attempt - 1) * 1000);
      return _fetchWithRetry(attempt + 1);
    }
    throw err;
  }
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
