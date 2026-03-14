/**
 * api/translate/index.js
 *
 * Azure Function v4 — POST /api/translate
 *
 * Translates an array of transcript segments using Azure Translator.
 * Never exposes the Translator key to the browser.
 *
 * Request body (JSON):
 *   {
 *     segments:   [{ id: number, text: string }, ...],  // max 100
 *     targetLang: string   // BCP-47 code, e.g. "es", "fr", "zh-Hans"
 *   }
 *
 * Response body (JSON):
 *   {
 *     translations: [{ id: number, text: string }, ...]
 *   }
 *
 * Required environment variables / App Settings:
 *   KEY_VAULT_NAME       — Key Vault name (reads via Managed Identity)
 *   --OR--
 *   TRANSLATOR_KEY       — raw key (local dev fallback)
 *   TRANSLATOR_REGION    — e.g. "eastus" (required for multi-service keys)
 *   TRANSLATOR_ENDPOINT  — optional; defaults to global endpoint
 */

'use strict';

const { app }           = require('@azure/functions');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient }  = require('@azure/keyvault-secrets');

// Module-level cache
let _cachedTranslatorKey    = null;
let _cachedTranslatorRegion = null;

const TRANSLATOR_ENDPOINT =
  process.env.TRANSLATOR_ENDPOINT ?? 'https://api.cognitive.microsofttranslator.com';

const MAX_SEGMENTS  = 100;
const MAX_TEXT_LEN  = 10_000;  // chars per segment (API limit is 50 k/request)

async function _getTranslatorCreds() {
  if (_cachedTranslatorKey) {
    return { key: _cachedTranslatorKey, region: _cachedTranslatorRegion };
  }

  const kvName = process.env.KEY_VAULT_NAME;
  if (kvName) {
    const credential = new DefaultAzureCredential();
    const client     = new SecretClient(`https://${kvName}.vault.azure.net`, credential);

    const [keySecret, regionSecret] = await Promise.all([
      client.getSecret('translator-key'),
      client.getSecret('translator-region').catch(() => ({ value: null })),
    ]);

    _cachedTranslatorKey    = keySecret.value;
    _cachedTranslatorRegion = regionSecret.value;
  } else {
    _cachedTranslatorKey    = process.env.TRANSLATOR_KEY;
    _cachedTranslatorRegion = process.env.TRANSLATOR_REGION ?? null;

    if (!_cachedTranslatorKey) {
      throw new Error(
        'Missing Translator credentials. Set KEY_VAULT_NAME (production) ' +
        'or TRANSLATOR_KEY (local dev).'
      );
    }
  }

  return { key: _cachedTranslatorKey, region: _cachedTranslatorRegion };
}

app.http('translate', {
  methods:   ['POST'],
  authLevel: 'anonymous',
  route:     'translate',

  handler: async (req, context) => {
    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, jsonBody: { error: 'Invalid JSON body.' } };
    }

    const { segments, targetLang } = body ?? {};

    // ── Input validation ────────────────────────────────────────────────────
    if (!Array.isArray(segments) || segments.length === 0) {
      return { status: 400, jsonBody: { error: '`segments` must be a non-empty array.' } };
    }

    if (segments.length > MAX_SEGMENTS) {
      return {
        status: 400,
        jsonBody: { error: `Too many segments. Maximum is ${MAX_SEGMENTS}.` },
      };
    }

    if (!targetLang || typeof targetLang !== 'string' || !/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})*$/.test(targetLang)) {
      return { status: 400, jsonBody: { error: 'Invalid `targetLang`.' } };
    }

    // Sanitise and cap segment text lengths
    const sanitised = segments.map(seg => ({
      id:   seg.id,
      text: String(seg.text ?? '').slice(0, MAX_TEXT_LEN),
    })).filter(seg => seg.text.trim().length > 0);

    if (!sanitised.length) {
      return { status: 200, jsonBody: { translations: [] } };
    }

    // ── Call Azure Translator ────────────────────────────────────────────────
    try {
      const { key, region } = await _getTranslatorCreds();

      const apiUrl = `${TRANSLATOR_ENDPOINT}/translate?api-version=3.0&to=${encodeURIComponent(targetLang)}`;

      const headers = {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/json',
      };

      if (region) {
        headers['Ocp-Apim-Subscription-Region'] = region;
      }

      const apiResp = await fetch(apiUrl, {
        method:  'POST',
        headers,
        body:    JSON.stringify(sanitised.map(s => ({ Text: s.text }))),
      });

      if (!apiResp.ok) {
        const errText = await apiResp.text();
        context.log.error('[translate] Translator API error:', apiResp.status, errText);
        return {
          status: 502,
          jsonBody: { error: 'Translation service error.' },
        };
      }

      const apiData = await apiResp.json();

      // Map results back to original segment IDs
      const translations = sanitised.map((seg, idx) => ({
        id:   seg.id,
        text: apiData[idx]?.translations?.[0]?.text ?? seg.text,
      }));

      return {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
        jsonBody: { translations },
      };
    } catch (err) {
      context.log.error('[translate] Error:', err.message);
      _cachedTranslatorKey    = null;
      _cachedTranslatorRegion = null;

      return {
        status: 500,
        jsonBody: { error: 'Internal error during translation.' },
      };
    }
  },
});
