# High-Level Design (HLD)
## PreachListen — Real-Time Preach Transcription & Translation Web Mobile App

**Version:** 1.0  
**Date:** March 13, 2026  
**Author:** Architecture Team  

---

## 1. Executive Summary

**PreachListen** is a Progressive Web App (PWA) designed for mobile browsers that allows worshippers to listen to a live or recorded preaching in any language, receive an AI-generated real-time transcript, and optionally view a live translation in their preferred language — all within a smart, memory-efficient dual-pane interface.

The system leverages Azure Cognitive Services (Speech + Translator), Azure Functions (serverless secure API gateway), and Azure Static Web Apps (hosting + CDN), backed by browser-side IndexedDB for zero-server-cost transcript storage resilient to long preaching sessions.

---

## 2. Goals & Non-Goals

### Goals
| # | Goal |
|---|------|
| G1 | Real-time speech-to-text transcription in any spoken language (150+ languages) |
| G2 | Automatic spoken-language detection — no user configuration required |
| G3 | On-demand live translation into 90+ languages via a swipeable second pane |
| G4 | Memory-safe rendering of transcripts of any length (1-hour+ sermons) |
| G5 | Mobile-first PWA: installable, offline-capable, works on iOS Safari and Android Chrome |
| G6 | Secure handling of Azure API keys — never exposed to the browser |
| G7 | Near-zero latency display of interim (live) and final transcript segments |

### Non-Goals
| # | Non-Goal |
|---|----------|
| NG1 | Speaker diarization (identifying individual speakers) — future phase |
| NG2 | Audio recording storage on Azure blob storage — all audio stays in-memory only |
| NG3 | User authentication / multi-user account system — single-user, session-based |
| NG4 | Native mobile app (iOS/Android) — PWA only |

---

## 3. System Context Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          USER DEVICE                                    │
│                                                                         │
│   ┌──────────────────────────────────────────────────────────────┐      │
│   │              Mobile Browser (Chrome / Safari)                │      │
│   │                                                              │      │
│   │  ┌─────────────────┐    ┌─────────────────────────────────┐  │      │
│   │  │  PWA (Frontend)  │    │  IndexedDB (Local Storage)      │  │      │
│   │  │  React/Vanilla   │◄──►│  Transcript Segments            │  │      │
│   │  │  JS + CSS        │    │  Translation Cache              │  │      │
│   │  └────────┬─────────┘    └─────────────────────────────────┘  │      │
│   └───────────┼──────────────────────────────────────────────────-┘      │
│               │ HTTPS / WSS                                              │
└───────────────┼──────────────────────────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                        MICROSOFT AZURE                                    │
│                                                                           │
│  ┌─────────────────────┐                                                  │
│  │  Azure Static Web   │  Hosts PWA assets via global CDN                │
│  │  Apps + CDN         │                                                  │
│  └─────────────────────┘                                                  │
│                                                                           │
│  ┌─────────────────────┐    ┌──────────────────┐  ┌──────────────────┐   │
│  │  Azure Functions    │───►│  Azure Speech    │  │ Azure Translator │   │
│  │  (API Gateway)      │    │  Service         │  │  Service         │   │
│  │  - /api/token       │    │  - STT           │  │  - 90+ langs     │   │
│  │  - /api/translate   │    │  - Lang Detect   │  │                  │   │
│  └──────────┬──────────┘    └──────────────────┘  └──────────────────┘   │
│             │                                                             │
│  ┌──────────▼──────────┐    ┌──────────────────────────────────────────┐  │
│  │   Azure Key Vault   │    │   Azure Application Insights              │  │
│  │   API Keys / Secrets│    │   Telemetry, Errors, Performance          │  │
│  └─────────────────────┘    └──────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Architecture Overview

### 4.1 Architecture Style
**Event-driven, serverless microservices** with a fat browser client (PWA) and thin serverless backend. The Speech SDK runs directly in the browser via WebSocket to Azure Speech Service for sub-second latency, while the Functions backend acts as a secure API gateway for key issuance and translation.

### 4.2 Tier Breakdown

| Tier | Component | Technology | Responsibility |
|------|-----------|------------|----------------|
| **Presentation** | PWA Frontend | Vanilla JS / CSS3 / Web APIs | UI rendering, audio capture, virtual scroll |
| **Client Storage** | IndexedDB | Browser IndexedDB (Dexie.js) | Transcript & translation segment persistence |
| **API Gateway** | Azure Functions | Node.js 20 LTS | Secure token endpoint, translation proxy |
| **AI — Speech** | Azure Speech Service | Cognitive Services | STT + auto language detection |
| **AI — Translation** | Azure Translator | Cognitive Services | Multi-language text translation |
| **Hosting & CDN** | Azure Static Web Apps | Azure CDN + GitHub Actions | PWA delivery, HTTPS, global edge |
| **Security** | Azure Key Vault | Azure Key Vault | API keys, connection strings |
| **Observability** | Azure App Insights | Azure Monitor | Error tracking, usage analytics |

---

## 5. Azure Component Architecture

### 5.1 Azure Speech Service
- **SKU:** S0 Standard (required for long audio and auto language detection)
- **Mode:** Real-time continuous recognition
- **Language Detection:** Automatic Language Identification (LID) — up to 10 candidate languages simultaneously, or open-set detection
- **Output:** JSON with recognized text, language code, confidence score, word timestamps
- **SDK:** Azure Cognitive Services Speech SDK for Browser (loaded from CDN)
- **Auth:** Browser SDK authenticates via short-lived STS token (valid 10 min) fetched from `/api/token`

### 5.2 Azure Translator
- **SKU:** S1 Standard
- **Use:** Translate accumulated transcript segments into target language on demand
- **Input protection:** Text chunked to ≤ 50,000 characters per API call
- **Language support:** 135 languages
- **Proxy:** All calls routed through Azure Functions (key never in browser)

### 5.3 Azure Functions
- **Runtime:** Node.js 20 on Consumption Plan
- **Endpoints:**
  - `GET /api/speech-token` — issues a 10-minute Speech STS token
  - `POST /api/translate` — proxies translation requests to Azure Translator
- **Identity:** System-assigned Managed Identity → Azure Key Vault (no API keys in config)
- **CORS:** Restricted to Static Web App domain only

### 5.4 Azure Static Web Apps
- **Plan:** Standard
- **Integrated CI/CD:** GitHub Actions
- **Routing:** Routes `/api/*` to linked Azure Functions automatically
- **CDN:** Global edge caching for static assets (JS, CSS, icons, audio worklet)
- **Custom domain + HTTPS:** Managed TLS certificate

### 5.5 Azure Key Vault
- **Stores:** Speech Service subscription key, Translator subscription key, region config
- **Access:** Azure Functions Managed Identity with `Key Vault Secrets User` role only
- **Soft-delete + Purge Protection:** Enabled for compliance

### 5.6 Azure Application Insights
- **Connection:** Instrumentation from PWA (client-side JS) + Azure Functions
- **Tracks:** Page loads, transcript events, translation latency, errors, session durations
- **PII filter:** Custom TelemetryInitializer strips transcript text before sending to prevent PII leakage

---

## 6. Data Flow — Transcription

```
1. User opens PWA in mobile browser
   └─► PWA loaded from Azure Static Web Apps (served via Azure CDN edge node)

2. User taps [●  RECORD / LISTEN]
   └─► PWA calls GET /api/speech-token via Azure Functions
         └─► Functions reads Speech Key from Azure Key Vault
         └─► Calls Azure Speech STS endpoint to exchange key for token
         └─► Returns { token, region } to PWA (token lifetime: 10 min, auto-refreshed)

3. Azure Speech SDK (browser) initiates WebSocket to Azure Speech Service
   └─► Language detection mode: auto (open-set)
   └─► Continuous recognition started

4. User's device microphone streams audio → Speech SDK processes locally
   └─► Every ~1-5 seconds: interim result (shown greyed-out in UI)
   └─► On silence/sentence boundary: final result (confirmed, persisted)

5. Final result handler:
   └─► Creates TranscriptSegment { id, text, language, timestamp, confidence }
   └─► Persists to IndexedDB transcriptSegments store
   └─► Appends to virtual scroll renderer
   └─► Updates session manifest in IndexedDB

6. Virtual Scroll renders:
   └─► Only 5-8 DOM nodes visible at any time
   └─► IntersectionObserver loads/unloads segments from IndexedDB
   └─► Auto-scroll to latest if user is at bottom; pauses if user scrolls up
```

---

## 7. Data Flow — Translation

```
1. User taps [⇄ TRANSLATE] button
   └─► Language picker dropdown appears
   └─► UI splits into dual-pane (original top / translated bottom OR side-by-side)

2. Visible segments identified by virtual scroll window manager
   └─► Segment IDs passed to TranslationManager

3. TranslationManager checks IndexedDB translationSegments cache
   └─► Cache HIT: render immediately
   └─► Cache MISS: batch un-translated visible segment IDs

4. POST /api/translate with { segments: [ { id, text } ], targetLang: "es" }
   └─► Azure Functions calls Azure Translator API
   └─► Returns { translations: [ { id, text } ] }

5. Results stored in IndexedDB translationSegments
6. Translation pane renders translated text aligned with original
7. As user scrolls: new visible segments trigger step 3 again
   └─► Already-translated segments always served from IndexedDB cache
```

---

## 8. Memory Management Strategy

| Mechanism | Detail |
|-----------|--------|
| **IndexedDB** | All final transcript segments stored in IndexedDB, NOT in JS heap |
| **Virtual DOM Window** | Maximum 8 rendered `<div>` segment nodes in DOM at any time |
| **IntersectionObserver** | Segments outside viewport are replaced with placeholder `<div>` of same height (recycling) |
| **Chunk Size** | Each segment: ~30-100 words / 5-10 sec of audio (~500 bytes avg) |
| **Session Manifest** | Lightweight index in sessionStorage: { totalSegments, firstId, lastId } |
| **Audio Buffers** | MediaRecorder buffers discarded immediately after Speech SDK processes them — never accumulated |
| **Translation Cache** | Translated segments stored in IndexedDB — re-translation of same segment never needed |
| **Stale Session Cleanup** | IndexedDB sessions older than 30 days auto-pruned on app open |

**Estimated Storage per 1-hour Sermon:**
- ~720 segments × 500 bytes (text) = ~360 KB raw transcript
- Translations (if enabled) = additional ~360 KB per language
- Total for 1-hour bilingual session: **< 1 MB** in IndexedDB
- IndexedDB quota: typically 50% of available disk space — effectively unlimited for this use case

---

## 9. UI Architecture

### 9.1 Screen Layout (Portrait)
```
┌─────────────────────────────┐
│  [🌐 EN → ES]  [●LIVE]  [⇄]│  ← Top toolbar
├─────────────────────────────┤
│                             │
│   TRANSCRIPT PANE           │
│   (original language)       │
│   Virtual Scrolling Region  │
│   [Segment 1 text...]       │
│   [Segment 2 text...]       │
│   [Interim: greyed text...] │
│                             │
├─────────────────────────────┤
│   TRANSLATION PANE          │  ← slides up on [⇄] tap
│   (selected language)       │
│   Virtual Scrolling Region  │
│   [Translated segment 1...] │
│   [Translated segment 2...] │
│                             │
├─────────────────────────────┤
│ [■ STOP]  [▷ PLAY]  [LANG▼]│  ← Bottom controls
└─────────────────────────────┘
```

### 9.2 Landscape Mode
- Transcript pane (left 50%) + Translation pane (right 50%)
- Both panes scroll independently with synchronized segment highlighting

---

## 10. Non-Functional Requirements

| NFR | Target |
|-----|--------|
| **Latency (transcript)** | < 2 seconds end-to-end for final results |
| **Latency (translation)** | < 1 second for cached; < 3 seconds for new segments |
| **Availability** | 99.9% (Azure SLA on all services) |
| **Browser support** | Chrome 90+, Safari 15+ (iOS), Edge 90+ |
| **Offline resilience** | Previously transcribed sessions viewable fully offline |
| **Audio processing** | 16 kHz mono PCM — optimal for Azure Speech Service |
| **Max session length** | Unlimited — constrained only by device storage quota |
| **Security** | OWASP Top 10, no API keys in browser, HTTPS only, strict CSP |

---

## 11. Technology Stack Summary

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Frontend | Vanilla JS (ES2022) + CSS3 | Zero build overhead, fast PWA, no framework bloat on mobile |
| Audio Capture | Web Audio API + MediaRecorder | Browser-native, no libraries needed |
| Speech | Azure Speech SDK (Browser) | Official SDK with WebSocket streaming to Azure Speech |
| Storage | IndexedDB via Dexie.js 3.x | Best-in-class IndexedDB wrapper, async, indexed queries |
| Virtual Scroll | Custom IntersectionObserver | Lightweight, no external library dependency |
| Backend | Azure Functions v4 (Node.js 20) | Serverless, pay-per-use, scales to zero between services |
| Hosting | Azure Static Web Apps (Standard) | Built-in CDN, GitHub Actions CI/CD, integrated Functions routing |
| Observability | Azure Application Insights | Full-stack telemetry, pre-built dashboards |
| Security | Azure Key Vault + Managed Identity | Zero-secret codebase pattern |

---

## 12. Deployment Architecture

```
GitHub Repository
       │
       │  Push to main
       ▼
GitHub Actions (CI/CD)
       │
       ├──► Build PWA assets (minify JS/CSS)
       │
       └──► Deploy to Azure Static Web Apps
                    │
                    ├── Static assets → Azure CDN (global edge)
                    └── /api/* routes → Azure Functions (Consumption)
                                              │
                                              ├── Managed Identity
                                              │         │
                                              └─────────►  Azure Key Vault
                                                              │
                                                   ┌──────────┴──────────┐
                                                   │                     │
                                             Azure Speech         Azure Translator
                                              Service               Service
```

---

## 13. Cost Estimation (Monthly — Typical Congregation)

| Service | Usage Estimate | Approx Cost (USD/mo) |
|---------|---------------|----------------------|
| Azure Static Web Apps | 1 app, Standard | $9 |
| Azure Functions | 500K invocations | ~$0.10 (within free tier) |
| Azure Speech Service | 5 hours/week × 4 = 20 hrs/mo | ~$30 (Standard S0) |
| Azure Translator | 500K chars/mo | ~$10 |
| Azure Key Vault | < 10K operations | ~$0.035 |
| Azure Application Insights | 1 GB data/mo | ~$2.30 |
| **Total Estimated** | | **~$52/month** |

> Note: Azure Speech Service is the dominant cost. Using the Speech SDK directly from browser (no relay) avoids double-billing on audio relay compute.

---

## 14. Security Posture

| Concern | Mitigation |
|---------|-----------|
| API Key Exposure | Keys in Key Vault only; browser receives short-lived STS tokens (10 min TTL) |
| XSS | Strict Content Security Policy; no `innerHTML` with user data; all text via `textContent` |
| CORS | Azure Functions CORS restricted to Static Web App domain only |
| Audio Privacy | Audio never leaves device RAM — only transcribed text is stored/transmitted |
| PII in Telemetry | App Insights TelemetryInitializer strips transcript content before sending |
| Transport Security | HTTPS/WSS enforced everywhere; HSTS headers on Static Web App |
| Input Validation | Translation API: text length capped at 5,000 chars per request in Function |

---

## 15. Future Enhancements (Out of Scope for v1)

| Enhancement | Description |
|-------------|-------------|
| Speaker Diarization | Identify multiple speakers in transcript |
| Azure Blob Storage | Optional cloud backup of session transcripts |
| Azure AD B2C | Multi-user with personal transcript history |
| Offline STT | On-device model via WebAssembly (Whisper WASM) for fully-offline use |
| Export | PDF / DOCX export of transcript + translation |
| Bible verse detection | AI-powered scripture reference detection and linking |

---

*End of High-Level Design Document*
