// src/auth/oidc.js — openid-client provider config for Google + Azure.
//
// Both providers are OIDC-compliant; one library, one code path. We cache the
// discovery result lazily so a missing env var doesn't break boot — the start
// route returns 503 PROVIDER_NOT_CONFIGURED instead (see routes/auth.js).

import * as oidc from 'openid-client'

let _google, _azure

function buildGoogle() {
  const id     = process.env.GOOGLE_CLIENT_ID
  const secret = process.env.GOOGLE_CLIENT_SECRET
  if (!id || !secret) return null
  return oidc.discovery(new URL('https://accounts.google.com'), id, secret)
}

function buildAzure() {
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

export function googleClient() { return _google ??= buildGoogle() }
export function azureClient()  { return _azure  ??= buildAzure()  }