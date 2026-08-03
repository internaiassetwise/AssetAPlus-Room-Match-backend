// src/auth/loginHandoff.js — Hand a finished login across an origin boundary.
//
// THE PROBLEM
// The frontend and the API live on different *.up.railway.app subdomains, and
// the frontend now reaches the API through a same-origin /api proxy (so Safari,
// which blocks third-party cookies outright, keeps the session cookie at all).
// But an OAuth callback still lands on whatever redirect_uri the provider has
// registered — the API's own host. A cookie set there belongs to the API host,
// and the browser will never send it to the frontend host. Login succeeds and
// the user still looks logged out.
//
// The clean fix is to register the frontend URL as the redirect_uri with each
// provider. That needs an admin on the Azure tenant, which we don't control, so
// this module bridges the gap instead:
//
//   provider → API-host callback → stash(cookies) → redirect to the frontend
//   frontend /auth/handoff → POST /api/auth/handoff (same origin, via the proxy)
//   → redeem(code) → Set-Cookie lands on the FRONTEND host ✓
//
// The code is single-use, expires in 60 seconds, and carries no identity of its
// own — it is a pointer to a session that was already minted. It does travel in
// a URL for one hop (so it can appear in history), which is why the window is
// this short and why redeem() deletes on first read even if it then rejects.
//
// Single-instance store, matching oidcStateStore: both halves of the exchange
// must reach the same process. That already holds for this deploy; if the API
// is ever scaled to multiple replicas, both this and the OIDC state store need
// to move to Postgres or Redis together.

import crypto from 'node:crypto'

const STORE = new Map()
const TTL_MS = 60 * 1000

setInterval(() => {
  const now = Date.now()
  for (const [k, v] of STORE) if (now - v.ts > TTL_MS) STORE.delete(k)
}, 30 * 1000).unref?.()

/**
 * Park a set of session cookies and return the one-time code that redeems them.
 *
 * @param {Array<{name:string, token:string, expiresAt:Date}>} cookies
 * @param {string} [returnTo]  Where the frontend should land afterwards.
 * @returns {string} the handoff code
 */
export function stash(cookies, returnTo = '/') {
  const code = crypto.randomBytes(32).toString('base64url')
  STORE.set(code, { cookies, returnTo, ts: Date.now() })
  return code
}

/**
 * Redeem a handoff code. Single-use: the entry is removed on the first read,
 * expired or not, so a leaked code cannot be retried.
 *
 * @param {string} code
 * @returns {{cookies: Array, returnTo: string} | null}
 */
export function redeem(code) {
  if (!code || typeof code !== 'string') return null
  const v = STORE.get(code)
  if (!v) return null
  STORE.delete(code)
  if (Date.now() - v.ts > TTL_MS) return null
  return { cookies: v.cookies, returnTo: v.returnTo }
}

/**
 * Is this request already on the same host the frontend is served from?
 *
 * When it is — local dev, or a deploy where the provider's redirect_uri points
 * at the frontend — the cookie can just be set here and no handoff is needed.
 * Keeping this check means the same code path works either way, and the handoff
 * quietly stops being used the day the redirect URIs get registered properly.
 *
 * @param {import('express').Request} req
 * @param {string} webOrigin  WEB_BASE_URL / APP_BASE_URL, may be empty
 */
export function isFrontendOrigin(req, webOrigin) {
  if (!webOrigin) return true            // no separate frontend origin configured
  try {
    return new URL(webOrigin).host === String(req.headers.host || '')
  } catch {
    return true                          // unparseable config — don't break login
  }
}
