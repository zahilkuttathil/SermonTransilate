/**
 * api/speech-token/index.js
 *
 * Azure Function v4 — GET /api/speech-token
 *
 * Returns a short-lived (10-min) Azure Speech STS token so the browser
 * never holds the raw subscription key.
 *
 * Required environment variables / App Settings:
 *   KEY_VAULT_NAME   — e.g. "mykv"  (reads secrets via Managed Identity)
 *   --OR--
 *   SPEECH_KEY       — raw key (local dev / non-Key-Vault fallback)
 *   SPEECH_REGION    — e.g. "eastus"
 *
 * Deployment note:
 *   Assign the Function App's Managed Identity the
 *   "Key Vault Secrets User" role on the Key Vault.
 */

'use strict';

const { app }           = require('@azure/functions');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient }  = require('@azure/keyvault-secrets');

// Module-level cache — persists across warm invocations
let _cachedKey    = null;
let _cachedRegion = null;

/**
 * Fetch Speech key + region from Key Vault (cached after first call).
 * Falls back to environment variables for local development.
 */
async function _getCredentials() {
  if (_cachedKey && _cachedRegion) {
    return { key: _cachedKey, region: _cachedRegion };
  }

  const kvName = process.env.KEY_VAULT_NAME;
  if (kvName) {
    const credential = new DefaultAzureCredential();
    const kvUrl      = `https://${kvName}.vault.azure.net`;
    const client     = new SecretClient(kvUrl, credential);

    const [keySecret, regionSecret] = await Promise.all([
      client.getSecret('speech-subscription-key'),
      client.getSecret('speech-region'),
    ]);

    _cachedKey    = keySecret.value;
    _cachedRegion = regionSecret.value;
  } else {
    // Local development: use env vars directly
    _cachedKey    = process.env.SPEECH_KEY;
    _cachedRegion = process.env.SPEECH_REGION;

    if (!_cachedKey || !_cachedRegion) {
      throw new Error(
        'Missing credentials. Set KEY_VAULT_NAME (production) ' +
        'or SPEECH_KEY + SPEECH_REGION (local dev).'
      );
    }
  }

  return { key: _cachedKey, region: _cachedRegion };
}

app.http('speech-token', {
  methods:   ['GET'],
  authLevel: 'anonymous',   // SWA handles authentication at the edge
  route:     'speech-token',

  handler: async (_req, context) => {
    try {
      const { key, region } = await _getCredentials();

      // Exchange subscription key for a short-lived STS token
      const stsUrl  = `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
      const stsResp = await fetch(stsUrl, {
        method:  'POST',
        headers: { 'Ocp-Apim-Subscription-Key': key },
      });

      if (!stsResp.ok) {
        context.log.error('[speech-token] STS exchange failed:', stsResp.status);
        return {
          status: 502,
          jsonBody: { error: 'Failed to obtain speech token from Azure.' },
        };
      }

      const token = await stsResp.text();

      return {
        status: 200,
        headers: {
          'Content-Type':  'application/json',
          'Cache-Control': 'no-store',
        },
        jsonBody: { token, region },
      };
    } catch (err) {
      context.log.error('[speech-token] Error:', err.message);
      // Invalidate cached credentials so next call retries Key Vault
      _cachedKey    = null;
      _cachedRegion = null;

      return {
        status: 500,
        jsonBody: { error: 'Internal error obtaining speech token.' },
      };
    }
  },
});
