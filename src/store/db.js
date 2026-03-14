/**
 * db.js
 * IndexedDB schema and helper functions via Dexie.js (loaded as UMD on window.Dexie).
 *
 * Tables:
 *   sessions            — one row per recording session
 *   transcriptSegments  — final speech-to-text segments (never accumulate in JS heap)
 *   translationSegments — cache of translated segments (avoids re-translating)
 *
 * Memory strategy:
 *   All text data lives in IndexedDB, not in JS arrays. The VirtualScroller
 *   fetches pages on demand and discards them from DOM when out of view.
 */

// Dexie is loaded as a UMD script that sets window.Dexie
const Dexie = window.Dexie;

const db = new Dexie('preachlisten_db');

db.version(1).stores({
  // sessions: PK, + indexes on createdAt and status
  sessions: '++id, createdAt, status',

  // transcriptSegments: compound index [sessionId+sequenceNum] for efficient paging
  transcriptSegments: '++id, sessionId, sequenceNum, [sessionId+sequenceNum], timestamp, language',

  // translationSegments: compound index [segmentId+targetLang] for cache lookup
  translationSegments: '++id, segmentId, targetLang, [segmentId+targetLang], cachedAt',
});

// ── Session helpers ─────────────────────────────────────────────────────────

/**
 * Create a new recording session.
 * @returns {Promise<number>} new session ID
 */
export async function createSession() {
  return db.sessions.add({
    createdAt: new Date().toISOString(),
    status: 'active',
    detectedLanguage: null,
    totalSegments: 0,
    title: null,
  });
}

/**
 * Mark a session as completed.
 * @param {number} sessionId
 */
export async function completeSession(sessionId) {
  await db.sessions.update(sessionId, { status: 'completed' });
}

/**
 * Get all sessions, newest first.
 * @returns {Promise<object[]>}
 */
export async function getAllSessions() {
  return db.sessions.orderBy('createdAt').reverse().toArray();
}

/**
 * Get a single session by ID.
 * @param {number} id
 * @returns {Promise<object|undefined>}
 */
export async function getSession(id) {
  return db.sessions.get(id);
}

/**
 * Delete a session and all its associated segments.
 * @param {number} sessionId
 */
export async function deleteSession(sessionId) {
  const segIds = await db.transcriptSegments
    .where('sessionId').equals(sessionId)
    .primaryKeys();
  await db.translationSegments
    .where('segmentId').anyOf(segIds)
    .delete();
  await db.transcriptSegments
    .where('sessionId').equals(sessionId)
    .delete();
  await db.sessions.delete(sessionId);
}

// ── Transcript segment helpers ───────────────────────────────────────────────

/**
 * Persist a final transcript segment to IndexedDB.
 *
 * @param {number} sessionId
 * @param {number} sequenceNum   - zero-based index within session
 * @param {object} data
 * @param {string} data.text
 * @param {string} data.language - BCP-47 code
 * @param {number} [data.confidence]
 * @param {number} [data.timestamp]
 * @returns {Promise<number>} new segment ID
 */
export async function addSegment(sessionId, sequenceNum, { text, language, confidence = 1.0, timestamp }) {
  const id = await db.transcriptSegments.add({
    sessionId,
    sequenceNum,
    text,
    language,
    confidence,
    timestamp: timestamp ?? Date.now(),
    isFinal: true,
  });

  // Update session metadata
  await db.sessions.where('id').equals(sessionId).modify(session => {
    session.totalSegments++;
    if (!session.detectedLanguage) {
      session.detectedLanguage = language;
    }
  });

  return id;
}

/**
 * Fetch a page of transcript segments for virtual scroll.
 *
 * @param {number} sessionId
 * @param {number} offset  - window start (sequenceNum)
 * @param {number} limit   - window size
 * @returns {Promise<object[]>}
 */
export async function getSegmentPage(sessionId, offset, limit) {
  return db.transcriptSegments
    .where('[sessionId+sequenceNum]')
    .between([sessionId, offset], [sessionId, offset + limit - 1], true, true)
    .toArray();
}

/**
 * Get total segment count for a session (without loading all rows).
 * @param {number} sessionId
 * @returns {Promise<number>}
 */
export async function getSegmentCount(sessionId) {
  return db.transcriptSegments.where('sessionId').equals(sessionId).count();
}

/**
 * Get all segment IDs (not full text) for a session — used by translation.
 * @param {number} sessionId
 * @returns {Promise<{id: number, sequenceNum: number, text: string}[]>}
 */
export async function getSegmentsMeta(sessionId, offset, limit) {
  return db.transcriptSegments
    .where('[sessionId+sequenceNum]')
    .between([sessionId, offset], [sessionId, offset + limit - 1], true, true)
    .toArray();
}

// ── Translation cache helpers ────────────────────────────────────────────────

/**
 * Look up a cached translation for a segment.
 * @param {number} segmentId
 * @param {string} targetLang  - BCP-47 code e.g. "es"
 * @returns {Promise<object|undefined>}
 */
export async function getCachedTranslation(segmentId, targetLang) {
  return db.translationSegments
    .where('[segmentId+targetLang]')
    .equals([segmentId, targetLang])
    .first();
}

/**
 * Store a batch of translation results in the cache.
 * @param {{ segmentId: number, targetLang: string, text: string }[]} translations
 */
export async function cacheTranslations(translations) {
  const records = translations.map(t => ({
    segmentId:  t.segmentId,
    targetLang: t.targetLang,
    text:       t.text,
    cachedAt:   Date.now(),
  }));
  await db.translationSegments.bulkPut(records);
}

/**
 * Fetch a page of cached translations for virtual scroll.
 * Returns an array matching the same window as getSegmentPage(),
 * with `text` being the translated string (or null if not yet cached).
 *
 * @param {number} sessionId
 * @param {string} targetLang
 * @param {number} offset
 * @param {number} limit
 * @returns {Promise<{sequenceNum: number, segmentId: number, text: string|null, originalText: string}[]>}
 */
export async function getTranslationPage(sessionId, targetLang, offset, limit) {
  const segments = await getSegmentsMeta(sessionId, offset, limit);
  const results = [];

  for (const seg of segments) {
    const cached = await getCachedTranslation(seg.id, targetLang);
    results.push({
      sequenceNum:  seg.sequenceNum,
      segmentId:    seg.id,
      text:         cached ? cached.text : null,
      originalText: seg.text,
      language:     seg.language,
    });
  }

  return results;
}

// ── Maintenance ──────────────────────────────────────────────────────────────

/**
 * Delete sessions (and all their data) older than the given number of days.
 * Called on app startup to prevent unbounded IndexedDB growth.
 * @param {number} [days=30]
 */
export async function pruneOldSessions(days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const oldSessions = await db.sessions
    .where('createdAt').below(cutoff)
    .toArray();

  for (const session of oldSessions) {
    await deleteSession(session.id);
  }
}

export { db };
