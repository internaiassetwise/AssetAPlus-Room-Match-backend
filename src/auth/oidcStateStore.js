// src/auth/oidcStateStore.js — In-memory store for OIDC state + PKCE verifier.
//
// Why this exists: the original implementation stored the OIDC state and
// PKCE code_verifier in browser cookies. That broke in production because
// the Microsoft/Google → backend redirect is cross-site, and browsers
// (Safari ITP, Chrome's scheme-based site boundaries, Railway's multi-
// subdomain setup) drop the cookies — even with SameSite=None; Secure.
//
// This store replaces cookies with a server-side Map keyed by the `state`
// value (which Azure/Google echo back unchanged in the callback URL).
// The state → {codeVerifier, returnTo} mapping lives in process memory for
// 10 minutes, then auto-expires. Works on single-instance Railway deploys.

const STORE = new Map()
const TTL_MS = 10 * 60 * 1000  // 10 minutes

// Clean up expired entries every 2 minutes to prevent memory bloat.
setInterval(() => {
  const now = Date.now()
  for (const [key, val] of STORE) {
    if (now - val.ts > TTL_MS) STORE.delete(key)
  }
}, 2 * 60 * 1000).unref?.()

/**
 * Save state → { codeVerifier, returnTo } for later lookup.
 * @param {string} state
 * @param {string} codeVerifier
 * @param {string} returnTo
 */
export function save(state, codeVerifier, returnTo) {
  STORE.set(state, { codeVerifier, returnTo, ts: Date.now() })
}

/**
 * Look up + delete the stored entry for a state value (single-use).
 * Returns { codeVerifier, returnTo } or null if not found / expired.
 * @param {string} state
 * @returns {{codeVerifier: string, returnTo: string} | null}
 */
export function take(state) {
  const val = STORE.get(state)
  if (!val) return null
  STORE.delete(state)  // single-use — prevents replay
  if (Date.now() - val.ts > TTL_MS) return null
  return { codeVerifier: val.codeVerifier, returnTo: val.returnTo }
}
