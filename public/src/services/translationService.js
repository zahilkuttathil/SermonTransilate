/**
 * translationService.js
 *
 * Translates transcript segments to a target language via /api/translate.
 *
 * Cache strategy:
 *   - Before calling the API, checks IndexedDB translationSegments table.
 *   - Only un-cached segments are sent to the API.
 *   - API results are persisted to IndexedDB immediately.
 *   - Re-translating the same segment+language pair never incurs an API call.
 *
 * Batching:
 *   - Segments are batched up to MAX_BATCH_CHARS characters per API call.
 *   - This stays safely below the Azure Translator 5,000-char per-element limit.
 */

import { getCachedTranslation, cacheTranslations } from '../store/db.js';

const TRANSLATE_ENDPOINT = 'https://apim-manna-25cfda35a7aa.azure-api.net/sermon/translate';
const MAX_BATCH_CHARS    = 4000;   // conservative limit per request
const MAX_RETRIES        = 2;

/**
 * Translate an array of transcript segments to the target language.
 * Already-translated segments come from cache; only missing ones hit the API.
 *
 * @param {{ id: number, text: string }[]} segments
 * @param {string} targetLang  BCP-47 or ISO 639-1 e.g. "es", "zh-Hans"
 * @returns {Promise<{ segmentId: number, targetLang: string, text: string }[]>}
 */
export async function translateSegments(segments, targetLang) {
  if (!segments.length) return [];

  const results = [];
  const missing = [];

  // Partition: cache hits vs misses
  for (const seg of segments) {
    const cached = await getCachedTranslation(seg.id, targetLang);
    if (cached) {
      results.push({ segmentId: seg.id, targetLang, text: cached.text });
    } else {
      missing.push(seg);
    }
  }

  if (!missing.length) return results;

  // Build batches by character budget
  const batches = _buildBatches(missing);

  for (const batch of batches) {
    const translations = await _callApi(batch, targetLang);
    await cacheTranslations(translations);
    results.push(...translations);
  }

  return results;
}

// ── Internal ────────────────────────────────────────────────────────────────

function _buildBatches(segments) {
  const batches = [];
  let current   = [];
  let charCount = 0;

  for (const seg of segments) {
    const len = seg.text.length;
    if (charCount + len > MAX_BATCH_CHARS && current.length) {
      batches.push(current);
      current   = [];
      charCount = 0;
    }
    current.push(seg);
    charCount += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function _callApi(batch, targetLang, attempt = 1) {
  const body = JSON.stringify({
    segments:   batch.map(s => ({ id: s.id, text: s.text })),
    targetLang,
  });

  let res;
  try {
    res = await fetch(TRANSLATE_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (networkErr) {
    if (attempt <= MAX_RETRIES) {
      await _sleep(500 * attempt);
      return _callApi(batch, targetLang, attempt + 1);
    }
    throw new Error(`Translation network error: ${networkErr.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (attempt <= MAX_RETRIES && res.status >= 500) {
      await _sleep(500 * attempt);
      return _callApi(batch, targetLang, attempt + 1);
    }
    throw new Error(`Translation API error ${res.status}: ${text}`);
  }

  const { translations } = await res.json();

  // Normalise to { segmentId, targetLang, text }
  return translations.map(t => ({
    segmentId:  t.id,
    targetLang,
    text:       t.text,
  }));
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
