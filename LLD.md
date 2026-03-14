# Low-Level Design (LLD)
## PreachListen — Real-Time Preach Transcription & Translation Web Mobile App

**Version:** 1.0  
**Date:** March 13, 2026  

---

## 1. Project Structure

```
preachlisten/
├── public/
│   ├── index.html
│   ├── manifest.json
│   ├── sw.js                         ← Service Worker (PWA)
│   └── icons/
│       ├── icon-192.png
│       └── icon-512.png
├── src/
│   ├── main.js                       ← App entry point
│   ├── store/
│   │   └── db.js                     ← Dexie.js IndexedDB schema & helpers
│   ├── services/
│   │   ├── speechService.js          ← Azure Speech SDK wrapper
│   │   ├── translationService.js     ← Translation API client
│   │   └── tokenService.js           ← STS token fetch & refresh
│   ├── ui/
│   │   ├── transcriptPane.js         ← Virtual scroll transcript renderer
│   │   ├── translationPane.js        ← Virtual scroll translation renderer
│   │   ├── toolbar.js                ← Top bar (language, status)
│   │   ├── controls.js               ← Bottom controls (record, stop, translate)
│   │   └── langPicker.js             ← Language selection dropdown
│   ├── utils/
│   │   ├── virtualScroller.js        ← IntersectionObserver virtual scroll engine
│   │   └── chunkBatcher.js           ← Batches translation requests
│   └── styles/
│       ├── main.css
│       └── panes.css
├── api/
│   ├── speech-token/
│   │   └── index.js                  ← Azure Function: GET /api/speech-token
│   └── translate/
│       └── index.js                  ← Azure Function: POST /api/translate
├── staticwebapp.config.json          ← SWA routing & headers config
├── host.json                         ← Azure Functions host config
└── package.json
```

---

## 2. Database Schema (IndexedDB via Dexie.js)

### 2.1 Database Name: `preachlisten_db` — Version: 1

```javascript
// src/store/db.js
import Dexie from 'dexie';

const db = new Dexie('preachlisten_db');

db.version(1).stores({
  sessions:            '++id, createdAt, status',
  transcriptSegments:  '++id, sessionId, sequenceNum, timestamp, language',
  translationSegments: '++id, segmentId, targetLang, cachedAt',
});
```

### 2.2 Table Definitions

#### `sessions`
| Field | Type | Description |
|-------|------|-------------|
| `id` | auto-increment (PK) | Unique session ID |
| `createdAt` | ISO timestamp | Session start time |
| `status` | `"active"` \| `"completed"` | Current status |
| `detectedLanguage` | string | BCP-47 code of primary detected language |
| `totalSegments` | number | Count of transcript segments |

#### `transcriptSegments`
| Field | Type | Description |
|-------|------|-------------|
| `id` | auto-increment (PK) | Unique segment ID |
| `sessionId` | number (FK → sessions.id) | Parent session |
| `sequenceNum` | number | Order within session (0, 1, 2, …) |
| `text` | string | Transcribed text of this segment |
| `language` | string | BCP-47 detected language code (e.g. `"en-US"`) |
| `confidence` | float | 0.0 – 1.0 recognition confidence |
| `timestamp` | number | ms since session start |
| `isFinal` | boolean | `true` = confirmed final; `false` = interim |

#### `translationSegments`
| Field | Type | Description |
|-------|------|-------------|
| `id` | auto-increment (PK) | Cache entry ID |
| `segmentId` | number (FK → transcriptSegments.id) | Source segment |
| `targetLang` | string | BCP-47 target language (e.g. `"es"`) |
| `text` | string | Translated text |
| `cachedAt` | number | Unix timestamp when cached |

---

## 3. Module Specifications

### 3.1 `tokenService.js`

**Responsibility:** Fetch, cache, and refresh Azure Speech STS token.

```javascript
// src/services/tokenService.js

const TOKEN_URL      = '/api/speech-token';
const TOKEN_TTL_MS   = 9 * 60 * 1000;  // refresh 1 minute before 10-min expiry

let cachedToken  = null;
let tokenExpiry  = 0;
let refreshTimer = null;

/**
 * Returns a valid { token, region } object.
 * Fetches from API if not yet obtained or about to expire.
 */
export async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res  = await fetch(TOKEN_URL);
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  const data = await res.json();   // { token: string, region: string }

  cachedToken = data;
  tokenExpiry = Date.now() + TOKEN_TTL_MS;

  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { cachedToken = null; }, TOKEN_TTL_MS);

  return cachedToken;
}
```

---

### 3.2 `speechService.js`

**Responsibility:** Wrap Azure Speech SDK. Handle continuous recognition, language detection, and emit events.

```javascript
// src/services/speechService.js
import * as SpeechSDK from 'microsoft-cognitiveservices-speech-sdk';
import { getToken } from './tokenService.js';
import { eventBus } from '../main.js';

let recognizer = null;

export async function startRecognition() {
  const { token, region } = await getToken();

  // Speech config from auth token
  const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
  speechConfig.speechRecognitionLanguage = 'auto';  // triggers LID

  // Auto Language Identification — open-set (no candidate list needed with S0)
  const autoDetect = SpeechSDK.AutoDetectSourceLanguageConfig.fromOpenRange();

  // Default microphone audio input
  const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();

  recognizer = SpeechSDK.ConversationTranscriber
    ? new SpeechSDK.ConversationTranscriber(speechConfig, audioConfig)
    : SpeechSDK.ConversationTranscriber;

  // Use SpeechRecognizer with AutoDetect for broad compat
  recognizer = new SpeechSDK.SpeechRecognizer(
    speechConfig,
    autoDetect,
    audioConfig
  );

  // Interim results (visual feedback only — NOT persisted)
  recognizer.recognizing = (_, e) => {
    eventBus.emit('transcript:interim', {
      text: e.result.text,
      language: e.result.language,
    });
  };

  // Final results — persist to IndexedDB
  recognizer.recognized = (_, e) => {
    if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
      eventBus.emit('transcript:final', {
        text:       e.result.text,
        language:   e.result.language,
        confidence: e.result.properties?.getProperty(
          SpeechSDK.PropertyId.SpeechServiceResponse_JsonResult
        ),
        timestamp:  Date.now(),
      });
    }
  };

  recognizer.canceled = (_, e) => {
    eventBus.emit('recognition:error', e.errorDetails);
    stopRecognition();
  };

  recognizer.startContinuousRecognitionAsync();
}

export function stopRecognition() {
  recognizer?.stopContinuousRecognitionAsync(() => {
    recognizer.close();
    recognizer = null;
    eventBus.emit('recognition:stopped');
  });
}
```

---

### 3.3 `db.js` — Storage Helpers

```javascript
// src/store/db.js  (helpers beyond schema)

/** Create a new session, return its id */
export async function createSession() {
  return db.sessions.add({
    createdAt: new Date().toISOString(),
    status: 'active',
    detectedLanguage: null,
    totalSegments: 0,
  });
}

/** Persist a final transcript segment */
export async function addSegment(sessionId, sequenceNum, { text, language, confidence, timestamp }) {
  const id = await db.transcriptSegments.add({
    sessionId, sequenceNum, text, language,
    confidence: confidence ?? 1.0,
    timestamp, isFinal: true,
  });
  await db.sessions.where('id').equals(sessionId)
    .modify(s => {
      s.totalSegments++;
      if (!s.detectedLanguage) s.detectedLanguage = language;
    });
  return id;
}

/** Fetch a page of segments for virtual scroll */
export async function getSegmentPage(sessionId, offset, limit = 8) {
  return db.transcriptSegments
    .where('[sessionId+sequenceNum]')
    .between([sessionId, offset], [sessionId, offset + limit], true, false)
    .toArray();
}

/** Get cached translation or null */
export async function getCachedTranslation(segmentId, targetLang) {
  return db.translationSegments
    .where({ segmentId, targetLang })
    .first();
}

/** Store translated segments */
export async function cacheTranslations(translations) {
  await db.translationSegments.bulkPut(
    translations.map(t => ({ ...t, cachedAt: Date.now() }))
  );
}

/** Prune sessions older than 30 days */
export async function pruneOldSessions() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const old = await db.sessions.where('createdAt').below(cutoff).toArray();
  for (const s of old) {
    const segs = await db.transcriptSegments.where('sessionId').equals(s.id).primaryKeys();
    await db.translationSegments.where('segmentId').anyOf(segs).delete();
    await db.transcriptSegments.where('sessionId').equals(s.id).delete();
    await db.sessions.delete(s.id);
  }
}
```

---

### 3.4 `virtualScroller.js`

**Responsibility:** Render only visible segment nodes; use IntersectionObserver to recycle DOM nodes and load/unload content from IndexedDB.

```javascript
// src/utils/virtualScroller.js

export class VirtualScroller {
  /**
   * @param {HTMLElement} container - The scrollable pane element
   * @param {Function}    fetchPage - async (offset, limit) => Segment[]
   * @param {Function}    renderItem - (segment) => HTMLElement
   */
  constructor(container, fetchPage, renderItem) {
    this.container  = container;
    this.fetchPage  = fetchPage;
    this.renderItem = renderItem;
    this.POOL_SIZE  = 8;          // Max rendered DOM nodes
    this.pool       = [];         // Reusable DOM nodes
    this.offset     = 0;          // Current window start index
    this.total      = 0;          // Total known segments
    this.autoScroll = true;       // Follow latest segment
    this._init();
  }

  _init() {
    // Top sentinel — triggers load of earlier segments when visible
    this.topSentinel = document.createElement('div');
    this.topSentinel.className = 'sentinel sentinel-top';
    this.container.prepend(this.topSentinel);

    // Bottom sentinel — triggers load of newer segments when visible
    this.bottomSentinel = document.createElement('div');
    this.bottomSentinel.className = 'sentinel sentinel-bottom';
    this.container.append(this.bottomSentinel);

    this.io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        if (e.target === this.topSentinel && this.offset > 0) {
          this.offset = Math.max(0, this.offset - this.POOL_SIZE);
          this._renderWindow();
        }
        if (e.target === this.bottomSentinel) {
          this._renderWindow();
        }
      });
    }, { root: this.container, threshold: 0.1 });

    this.io.observe(this.topSentinel);
    this.io.observe(this.bottomSentinel);

    // Detect manual scroll up → pause auto-scroll
    this.container.addEventListener('scroll', () => {
      const atBottom = this.container.scrollHeight -
        this.container.scrollTop - this.container.clientHeight < 50;
      this.autoScroll = atBottom;
    });
  }

  async _renderWindow() {
    const segments = await this.fetchPage(this.offset, this.POOL_SIZE);
    // Clear existing pool items (recycle)
    this.pool.forEach(node => node.remove());
    this.pool = [];

    segments.forEach(seg => {
      const el = this.renderItem(seg);
      el.dataset.segmentId = seg.id;
      this.topSentinel.after(el);   // insert after top sentinel
      this.pool.push(el);
    });

    if (this.autoScroll) this._scrollToBottom();
  }

  /** Called when a new live segment arrives */
  async onNewSegment(total) {
    this.total = total;
    if (this.autoScroll) {
      this.offset = Math.max(0, total - this.POOL_SIZE);
      await this._renderWindow();
    }
  }

  _scrollToBottom() {
    this.bottomSentinel.scrollIntoView({ behavior: 'smooth' });
  }
}
```

---

### 3.5 `translationService.js`

**Responsibility:** Batch un-translated segments and call the `/api/translate` proxy.

```javascript
// src/services/translationService.js
import { getCachedTranslation, cacheTranslations } from '../store/db.js';

const TRANSLATE_URL  = '/api/translate';
const MAX_BATCH_CHARS = 4500;   // Stay well under Azure Translator 5000-char limit per element

/**
 * Translate an array of segment objects to targetLang.
 * Returns array of { segmentId, targetLang, text }
 */
export async function translateSegments(segments, targetLang) {
  // 1. Split into cache hits and misses
  const results = [];
  const missing = [];

  for (const seg of segments) {
    const cached = await getCachedTranslation(seg.id, targetLang);
    if (cached) {
      results.push({ segmentId: seg.id, targetLang, text: cached.text });
    } else {
      missing.push(seg);
    }
  }

  if (!missing.length) return results;

  // 2. Batch missing segments into ≤ MAX_BATCH_CHARS groups
  const batches = [];
  let currentBatch = [];
  let currentChars = 0;

  for (const seg of missing) {
    if (currentChars + seg.text.length > MAX_BATCH_CHARS && currentBatch.length) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
    currentBatch.push(seg);
    currentChars += seg.text.length;
  }
  if (currentBatch.length) batches.push(currentBatch);

  // 3. POST each batch
  for (const batch of batches) {
    const res = await fetch(TRANSLATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        segments: batch.map(s => ({ id: s.id, text: s.text })),
        targetLang,
      }),
    });
    if (!res.ok) throw new Error(`Translation API error: ${res.status}`);
    const { translations } = await res.json();

    await cacheTranslations(translations.map(t => ({
      segmentId: t.id,
      targetLang,
      text: t.text,
    })));

    translations.forEach(t => results.push({ segmentId: t.id, targetLang, text: t.text }));
  }

  return results;
}
```

---

### 3.6 `transcriptPane.js`

```javascript
// src/ui/transcriptPane.js
import { VirtualScroller } from '../utils/virtualScroller.js';
import { getSegmentPage }  from '../store/db.js';
import { eventBus }        from '../main.js';

export function initTranscriptPane(sessionId) {
  const container = document.getElementById('transcript-pane');
  const scroller  = new VirtualScroller(
    container,
    (offset, limit) => getSegmentPage(sessionId, offset, limit),
    renderSegment
  );

  // Live interim text shown at bottom
  const interimEl = document.createElement('div');
  interimEl.className = 'segment segment--interim';
  container.append(interimEl);

  eventBus.on('transcript:interim', ({ text }) => {
    interimEl.textContent = text;
  });

  eventBus.on('transcript:final', async (_, total) => {
    interimEl.textContent = '';
    await scroller.onNewSegment(total);
  });

  return scroller;
}

function renderSegment(seg) {
  const el = document.createElement('div');
  el.className = 'segment segment--final';

  const langBadge = document.createElement('span');
  langBadge.className = 'segment__lang';
  langBadge.textContent = seg.language.split('-')[0].toUpperCase();

  const text = document.createElement('p');
  text.className = 'segment__text';
  text.textContent = seg.text;  // textContent — NEVER innerHTML (XSS prevention)

  el.append(langBadge, text);
  return el;
}
```

---

### 3.7 Azure Function — `speech-token/index.js`

```javascript
// api/speech-token/index.js
const { app } = require('@azure/functions');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient }           = require('@azure/keyvault-secrets');
const axios                      = require('axios');

const kvUri = `https://${process.env.KEY_VAULT_NAME}.vault.azure.net`;

let _secretCache = null;

async function getSecrets() {
  if (_secretCache) return _secretCache;
  const cred   = new DefaultAzureCredential();
  const client = new SecretClient(kvUri, cred);
  const [key, region] = await Promise.all([
    client.getSecret('speech-subscription-key'),
    client.getSecret('speech-region'),
  ]);
  _secretCache = { key: key.value, region: region.value };
  return _secretCache;
}

app.http('speech-token', {
  methods: ['GET'],
  authLevel: 'anonymous',   // Protected by allowed-origins CORS, not auth level
  handler: async (req, ctx) => {
    try {
      const { key, region } = await getSecrets();
      const stsUrl = `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
      const { data: token } = await axios.post(stsUrl, null, {
        headers: { 'Ocp-Apim-Subscription-Key': key },
      });
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, region }),
      };
    } catch (err) {
      ctx.log.error('speech-token error:', err.message);
      return { status: 500, body: 'Internal error' };
    }
  },
});
```

---

### 3.8 Azure Function — `translate/index.js`

```javascript
// api/translate/index.js
const { app } = require('@azure/functions');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient }           = require('@azure/keyvault-secrets');
const axios                      = require('axios');

const kvUri = `https://${process.env.KEY_VAULT_NAME}.vault.azure.net`;
let _translatorKey = null;

async function getTranslatorKey() {
  if (_translatorKey) return _translatorKey;
  const cred   = new DefaultAzureCredential();
  const client = new SecretClient(kvUri, cred);
  const secret = await client.getSecret('translator-subscription-key');
  _translatorKey = secret.value;
  return _translatorKey;
}

app.http('translate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (req, ctx) => {
    try {
      const body = await req.json();
      const { segments, targetLang } = body;

      // Input validation
      if (!Array.isArray(segments) || !targetLang) {
        return { status: 400, body: 'Invalid request' };
      }
      if (segments.length > 100) {
        return { status: 400, body: 'Max 100 segments per request' };
      }
      // Cap each segment text length
      const sanitizedSegments = segments.map(s => ({
        id: s.id,
        text: String(s.text).slice(0, 5000),
      }));

      const key = await getTranslatorKey();
      const endpoint = 'https://api.cognitive.microsofttranslator.com/translate';

      const { data } = await axios.post(
        `${endpoint}?api-version=3.0&to=${encodeURIComponent(targetLang)}`,
        sanitizedSegments.map(s => ({ Text: s.text })),
        {
          headers: {
            'Ocp-Apim-Subscription-Key': key,
            'Ocp-Apim-Subscription-Region': process.env.TRANSLATOR_REGION,
            'Content-Type': 'application/json',
          },
        }
      );

      const translations = data.map((result, i) => ({
        id:   sanitizedSegments[i].id,
        text: result.translations[0].text,
      }));

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ translations }),
      };
    } catch (err) {
      ctx.log.error('translate error:', err.message);
      return { status: 500, body: 'Internal error' };
    }
  },
});
```

---

### 3.9 `staticwebapp.config.json`

```json
{
  "routes": [
    {
      "route": "/api/*",
      "allowedRoles": ["anonymous"]
    }
  ],
  "navigationFallback": {
    "rewrite": "/index.html",
    "exclude": ["/api/*", "/*.{css,js,png,ico,json,webp,svg}"]
  },
  "globalHeaders": {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    "X-Content-Type-Options":    "nosniff",
    "X-Frame-Options":           "DENY",
    "Content-Security-Policy":   "default-src 'self'; connect-src 'self' wss://*.stt.speech.microsoft.com https://*.api.cognitive.microsoft.com ; script-src 'self' https://aka.ms/csspeech/jsbrowserpackageraw ; style-src 'self' 'unsafe-inline'; media-src 'self' blob:;",
    "Referrer-Policy":           "strict-origin-when-cross-origin",
    "Permissions-Policy":        "microphone=*"
  },
  "mimeTypes": {
    ".json": "application/json"
  }
}
```

---

## 4. State Machine — Recording Session

```
IDLE
 │
 │  [Tap RECORD]
 ▼
REQUESTING_TOKEN ──── error ──→ ERROR_STATE
 │
 │  token received
 ▼
CONNECTING ──── timeout ──→ ERROR_STATE
 │
 │  SDK ready
 ▼
RECORDING ◄─────────────────────┐
 │  (interim results flowing)   │
 │                              │  token refresh (auto)
 │  [Tap STOP]                  │
 ▼                              │
STOPPING ───────────────────────┘
 │
 │  SDK closed
 ▼
COMPLETED
 │
 │  [Tap TRANSLATE]
 ▼
TRANSLATING ──── error ──→ TRANSLATION_ERROR
 │
 │  results cached
 ▼
TRANSLATED (session stays viewable offline)
```

---

## 5. Event Bus API

All modules communicate via a lightweight publish/subscribe event bus in `main.js`.

| Event | Payload | Publisher | Subscriber(s) |
|-------|---------|-----------|---------------|
| `transcript:interim` | `{ text, language }` | `speechService` | `transcriptPane` |
| `transcript:final` | `{ text, language, confidence, timestamp }` | `speechService` | `main.js` (persists) → `transcriptPane` |
| `recognition:error` | `{ message }` | `speechService` | `toolbar` (shows error banner) |
| `recognition:stopped` | — | `speechService` | `controls` (updates button state) |
| `session:created` | `{ sessionId }` | `main.js` | `transcriptPane`, `translationPane` |
| `translate:request` | `{ targetLang }` | `controls` | `translationPane` |
| `translate:complete` | `{ segmentIds }` | `translationPane` | `translationPane` (re-render) |

---

## 6. CSS Architecture

### 6.1 Layout (main.css)
```css
:root {
  --color-primary:    #0078D4;  /* Azure Blue */
  --color-secondary:  #005A9E;
  --color-bg:         #F3F2F1;
  --color-surface:    #FFFFFF;
  --color-interim:    #A19F9D;
  --color-badge:      #D13438;
  --font-base:        'Segoe UI', system-ui, sans-serif;
  --pane-header-h:    48px;
  --controls-h:       64px;
}

body {
  margin: 0; padding: 0;
  font-family: var(--font-base);
  background: var(--color-bg);
  overscroll-behavior: none;
}

.app-layout {
  display: flex;
  flex-direction: column;
  height: 100dvh;               /* dynamic viewport height — correct on iOS */
  overflow: hidden;
}

.pane {
  flex: 1 1 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 12px 16px;
  background: var(--color-surface);
  border-top: 1px solid #EDEBE9;
}

/* Dual-pane: each pane takes 50% height in portrait */
.app-layout.dual .pane {
  flex: 0 0 calc(50dvh - var(--pane-header-h) - var(--controls-h) / 2);
}
```

### 6.2 Segment Styles (panes.css)
```css
.segment {
  margin-bottom: 12px;
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.segment__lang {
  flex-shrink: 0;
  background: var(--color-primary);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  border-radius: 4px;
  padding: 2px 5px;
  margin-top: 2px;
}

.segment__text {
  margin: 0;
  font-size: 15px;
  line-height: 1.5;
  color: #323130;
}

.segment--interim .segment__text {
  color: var(--color-interim);
  font-style: italic;
}

.sentinel { height: 1px; visibility: hidden; }
```

---

## 7. Service Worker (PWA — sw.js)

```javascript
// public/sw.js
const CACHE_NAME = 'preachlisten-v1';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/src/main.js',
  '/src/styles/main.css',
  '/src/styles/panes.css',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network-first for API calls; cache-first for assets
  if (e.request.url.includes('/api/')) {
    e.respondWith(fetch(e.request).catch(() =>
      new Response(JSON.stringify({ error: 'offline' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    ));
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
```

---

## 8. Azure Function Configuration

### `host.json`
```json
{
  "version": "2.0",
  "logging": {
    "applicationInsights": {
      "samplingSettings": { "isEnabled": true }
    }
  },
  "extensions": {
    "http": {
      "routePrefix": "api"
    }
  }
}
```

### Required App Settings (set via Azure Portal or `azd env set`)
| Setting | Value |
|---------|-------|
| `KEY_VAULT_NAME` | Name of your Azure Key Vault |
| `TRANSLATOR_REGION` | Azure region of Translator (e.g. `eastus`) |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | App Insights connection string |

### Key Vault Secrets Required
| Secret Name | Description |
|-------------|-------------|
| `speech-subscription-key` | Azure Speech Service key |
| `speech-region` | Speech Service region (e.g. `eastus`) |
| `translator-subscription-key` | Translator subscription key |

---

## 9. Performance Benchmarks (Design Targets)

| Metric | Target | Mechanism |
|--------|--------|-----------|
| Time to Interactive | < 2s on 3G | Minified bundle < 50KB |
| First Transcript Segment | < 3s after mic grant | Token pre-fetched on load |
| Translation latency (cached) | < 50ms | IndexedDB sync read |
| Translation latency (live) | < 1.5s | Batched Azure Translator call |
| DOM nodes in transcript pane | ≤ 8 at any time | VirtualScroller pool |
| JS heap per 1hr session | < 15 MB | No segment accumulation in memory |
| IndexedDB usage per 1hr | < 1 MB | Text-only, no audio |

---

## 10. Error Handling Matrix

| Scenario | Detection | Recovery |
|----------|-----------|----------|
| Mic permission denied | `getUserMedia` rejection | Toast: "Please allow microphone access" |
| Network offline (on load) | `navigator.onLine` | Show offline banner; previous sessions viewable |
| Token fetch failure | HTTP 5xx | Retry 3× with exponential backoff, then error state |
| Speech SDK WebSocket drop | `recognizer.canceled` event | Auto-reconnect once; if fails, show "Connection lost" |
| Translation API failure | HTTP 5xx | Toast with "Translation temporarily unavailable"; retry button |
| IndexedDB quota exceeded | DOMException | Offer to clear oldest session; degrade to in-memory mode |
| Unsupported browser | `window.indexedDB` check | Graceful degradation notice |

---

## 11. Dependency List

### Frontend (no build system — CDN loaded)
| Library | Version | Source | Purpose |
|---------|---------|--------|---------|
| Azure Speech SDK | latest | `aka.ms/csspeech/jsbrowserpackageraw` | Speech recognition |
| Dexie.js | 3.x | `unpkg.com/dexie` | IndexedDB wrapper |

### Backend (Azure Functions — npm)
| Package | Version | Purpose |
|---------|---------|---------|
| `@azure/functions` | 4.x | Azure Functions v4 programming model |
| `@azure/identity` | 4.x | DefaultAzureCredential / Managed Identity |
| `@azure/keyvault-secrets` | 4.x | Key Vault secret access |
| `axios` | 1.x | HTTP client for Speech STS + Translator |

---

*End of Low-Level Design Document*
