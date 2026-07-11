// src/auth/sessions.js — Cookie names + helpers shared by public + admin auth.
//
// Cookie naming convention: <role>_session (user_session, landlord_session,
// admin_session). All session cookies ride the same set of options via the
// `sessionCookieOptions()` helper below; routes should call it instead of
// res.cookie() directly so prod/sameSite/Domain stay consistent.
//
// We piggyback openid-client's state/PKCE storage on req.__oidcCookies via a
// side-channel — see `oidcCookieStore` below. openid-client v6 expects a store
// with get/set/delete; we route writes through req so the actual `res.cookie()`
// calls happen in the route handler after we know what's needed.

export const USER_COOKIE     = 'user_session'
export const LANDLORD_COOKIE = 'landlord_session'
export const ADMIN_COOKIE    = 'admin_session'

export { readCookie } from '../middleware/requireAdmin.js'

import { isProd } from '../config.js'

/**
 * Cookie Domain for prod cross-subdomain deploys (e.g. Railway, where the
 * frontend and backend live on different `.up.railway.app` subdomains). Without
 * `Domain=` set, cookies become host-only and the browser won't send them
 * back across subdomains — see RFC 6265 §5.2.3.
 *
 * Set COOKIE_DOMAIN=".up.railway.app" (or ".your-shared-parent.example.com")
 * in the prod environment. Leave blank in dev (same-origin via Vite proxy).
 */
export function cookieDomain() {
  if (!isProd) return undefined
  return process.env.COOKIE_DOMAIN || undefined
}

/**
 * Standard session-cookie options for res.cookie(). Centralises Secure,
 * SameSite, Domain, path so a flip in one place (e.g. cross-domain prod)
 * updates every Set-Cookie in the codebase. Use this for new code; legacy
 * callers are migrated inline.
 */
export function sessionCookieOptions({ expires, maxAge } = {}) {
  const opts = {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure:   isProd,
    path:     '/',
  }
  const domain = cookieDomain()
  if (domain) opts.domain = domain
  if (expires) opts.expires = expires
  if (maxAge != null) opts.maxAge = maxAge
  return opts
}

/**
 * openid-client state + nonce + PKCE-verifier cookie store, wired to req.
 *
 * Why a side-channel: openid-client calls `store.set(key, value)` BEFORE the
 * route knows what cookies to send. We can't call `res.cookie()` from inside
 * `store.set()` because the response may not be ready. So we stash on req,
 * and the route flushes req.__oidcCookies onto res after building the URL.
 */
export const oidcCookieStore = {
  get: (req) => (key) => {
    const raw = req.headers.cookie || ''
    const m = raw.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`))
    return m ? { value: decodeURIComponent(m[1]) } : undefined
  },
  set: (_res, req) => (key, value) => {
    req.__oidcCookies ??= []
    req.__oidcCookies.push({ key, value, op: 'set' })
  },
  delete: (_res, req) => (key) => {
    req.__oidcCookieDeletes ??= []
    req.__oidcCookieDeletes.push(key)
  },
}

/** Flush pending cookie writes/deletes from the side-channel onto res. */
export function flushOidcCookies(req, res) {
  if (req.__oidcCookies) {
    for (const { key, value } of req.__oidcCookies) {
      res.cookie(key, value, {
        httpOnly: true,
        sameSite: 'lax',         // OIDC redirect flow — same browser session
        secure: process.env.NODE_ENV === 'production',
        maxAge: 10 * 60 * 1000,  // 10 min — enough to complete the round-trip
        path: '/',
      })
    }
  }
  if (req.__oidcCookieDeletes) {
    for (const key of req.__oidcCookieDeletes) {
      res.clearCookie(key, { path: '/' })
    }
  }
}

/** Sanitize the ?return= query param — only allow same-origin relative paths.
 *  Blocks protocol-relative URLs (//host), backslash variants (/\host, which
 *  some browsers normalize to //host → off-site redirect), and percent-encoded
 *  sequences (%2F) that could evade the checks. */
export function sanitizeReturn(value) {
  if (typeof value !== 'string') return '/'
  const v = value.trim()
  if (!v.startsWith('/') || v.startsWith('//')) return '/'
  if (/[\\%]/.test(v)) return '/'
  return v
}