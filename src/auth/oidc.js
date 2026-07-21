// src/auth/oidc.js — openid-client provider config for Google + Azure.
//
// Both providers are OIDC-compliant; one library, one code path. We cache the
// discovery result lazily so a missing env var doesn't break boot — the start
// route returns 503 PROVIDER_NOT_CONFIGURED instead (see routes/auth.js).
//
// openid-client v6: discovery() is ASYNC — it fetches the issuer's
// .well-known/openid-configuration over HTTP. The clients below are async
// getters that await + cache the resolved Configuration so callers always
// receive a Configuration object, not a stale Promise.

import * as oidc from 'openid-client'

let _google, _azure

async function buildGoogle() {
  const id     = process.env.GOOGLE_CLIENT_ID
  const secret = process.env.GOOGLE_CLIENT_SECRET
  if (!id || !secret) return null
  return oidc.discovery(new URL('https://accounts.google.com'), id, secret)
}

async function buildAzure() {
  const tenantId = process.env.AZURE_TENANT_ID
  const id       = process.env.AZURE_CLIENT_ID
  const secret   = process.env.AZURE_CLIENT_SECRET
  if (!tenantId || !id || !secret) return null
  // 'common' lets multi-tenant apps work; the configured tenantId restricts to one.
  return oidc.discovery(
    new URL(`https://login.microsoftonline.com/${tenantId}/v2.0`),
    id,
    secret,
  )
}

/** Lazy async getter — awaits + caches the Google OIDC Configuration. */
export async function googleClient() {
  if (!_google) _google = await buildGoogle()
  return _google
}

/** Lazy async getter — awaits + caches the Azure OIDC Configuration. */
export async function azureClient() {
  if (!_azure) _azure = await buildAzure()
  return _azure
}