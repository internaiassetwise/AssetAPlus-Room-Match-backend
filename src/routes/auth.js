// src/routes/auth.js — All session-cookie login paths.
//
// Endpoints:
//   POST /auth/login                — local admin (username/password)
//   POST /auth/logout               — admin logout
//   GET  /auth/me                   — admin /me
//
//   GET  /auth/google/start, .../callback — Google OIDC for tenants
//   POST /auth/user/logout          — tenant logout
//   GET  /auth/user/me              — current tenant identity or 204
//
//   GET  /auth/azure/start, .../callback  — Azure OIDC for staff admins
//
//   POST /auth/mock/login           — DEV-ONLY mock login (gated by MOCK_AUTH=true)
//   GET  /auth/landlord/me          — current landlord identity or 204
//   POST /auth/landlord/logout      — landlord logout
//
// Every Set-Cookie in this file uses `setSessionCookie()` so prod
// cross-domain (Domain=), Secure, and SameSite stay consistent.

import { Router } from 'express'
import { z } from 'zod'
import * as oidc from 'openid-client'
import * as admins           from '../db/repositories/admins.repo.js'
import * as tenants          from '../db/repositories/tenants.repo.js'
import * as userSessions     from '../db/repositories/userSessions.repo.js'
import * as landlordSessions from '../db/repositories/landlordSessions.repo.js'
import { asyncHandler }        from '../middleware/_asyncHandler.js'
import { validate }            from '../middleware/validate.js'
import { AppError }            from '../middleware/AppError.js'
import { requireAdmin, ADMIN_COOKIE, readCookie } from '../middleware/requireAdmin.js'
import { googleClient, azureClient } from '../auth/oidc.js'
import {
  USER_COOKIE, LANDLORD_COOKIE,
  oidcCookieStore, sanitizeReturn, flushOidcCookies,
  sessionCookieOptions,
} from '../auth/sessions.js'
import { config } from '../config.js'

export const auth = Router()

/**
 * Centralised Set-Cookie for session tokens. Always uses sessionCookieOptions()
 * so Domain=, Secure, SameSite, and path stay aligned with the rest of the
 * codebase. Switch secure-mode / cross-subdomain behaviour in ONE place.
 */
function setSessionCookie(res, name, token, expiresAt) {
  res.cookie(name, token, sessionCookieOptions({ expires: expiresAt }))
}

/**
 * Parse CORS_ORIGIN exactly the way app.js does, so the mock-login CSRF check
 * matches the CORS allow-list. Returns true if origin should be allowed.
 */
function originMatchesCORS(req) {
  const origin = req.headers.origin
  if (!origin) return true   // server-to-server / curl; let it pass
  const raw = (config.CORS_ORIGIN || '').trim()
  if (!raw || raw === '*') return true
  const allowed = raw
    .split(',')
    .map((s) => s.trim().replace(/^["']+|["']+$/g, '').replace(/\/+$/, ''))
    .map((s) => /^https?:\/\//i.test(s) ? s : `https://${s}`)
    .filter(Boolean)
  // Allow both the configured origin AND root-relative forms (e.g. localhost:5173 in dev).
  return allowed.includes(origin)
}

// ─────────────────────────── Local admin login (kept live) ──────────────────

const loginBody = z.object({
  username: z.string().trim().min(1, 'กรุณากรอกชื่อผู้ใช้').max(120),
  password: z.string().min(1, 'กรุณากรอกรหัสผ่าน').max(200),
})

auth.post('/login', validate({ body: loginBody }), asyncHandler(async (req, res) => {
  const { username, password } = req.body
  const admin = await admins.findByUsername(username)
  if (!admin || !admin.is_active) {
    throw new AppError(401, 'AUTH_BAD_CREDENTIALS', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง')
  }
  const ok = await admins.verifyPassword(password, admin.password_hash)
  if (!ok) {
    throw new AppError(401, 'AUTH_BAD_CREDENTIALS', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง')
  }
  const { token, expiresAt } = await admins.createSession(admin.id)
  await admins.touchLastLogin(admin.id)
  setSessionCookie(res, ADMIN_COOKIE, token, expiresAt)
  res.json({ id: admin.id, username: admin.username })
}))

auth.post('/logout', asyncHandler(async (req, res) => {
  const token = readCookie(req, ADMIN_COOKIE)
  if (token) await admins.destroySession(token)
  res.clearCookie(ADMIN_COOKIE, { path: '/' })
  res.json({ ok: true })
}))

auth.get('/me', requireAdmin, asyncHandler(async (req, res) => {
  res.json({ id: req.admin.id, username: req.admin.username })
}))

// ─────────────────────────── Google OIDC (public users) ──────────────────────
//
// Flow:
//   GET /auth/google/start?return=/path
//     → 302 to Google's consent screen with PKCE + state
//   GET /auth/google/callback?code=&state=
//     → exchange code, upsert tenant, set user_session cookie, redirect to ?return

auth.get('/google/start', asyncHandler(async (req, res) => {
  const client = googleClient()
  if (!client) {
    return res.status(503).json({
      ok: false,
      error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'Google sign-in is not configured yet' },
    })
  }
  const returnTo = sanitizeReturn(req.query.return)
  const state = oidc.randomState()
  const codeVerifier = oidc.randomPKCECodeVerifier()
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier)
  const authUrl = oidc.buildAuthorizationUrl(client, {
    redirect_uri:           process.env.GOOGLE_REDIRECT_URI,
    scope:                  'openid email profile',
    state,
    code_challenge:         codeChallenge,
    code_challenge_method:  'S256',
  })
  // Persist state + PKCE verifier in short-lived cookies for the round-trip.
  oidcCookieStore.set(res, req)('oidc_state', state)
  oidcCookieStore.set(res, req)('oidc_code_verifier', codeVerifier)
  oidcCookieStore.set(res, req)('oidc_return_to', returnTo)
  flushOidcCookies(req, res)
  res.redirect(authUrl.href)
}))

auth.get('/google/callback', asyncHandler(async (req, res) => {
  const client = googleClient()
  if (!client) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Google sign-in is not configured yet')

  const currentUrl = new URL(req.originalUrl, `${req.protocol}://${req.headers.host}`)
  const tokens = await oidc.authorizationCodeGrant(client, currentUrl, {
    expectedState:     readCookie(req, 'oidc_state'),
    pkceCodeVerifier:  readCookie(req, 'oidc_code_verifier'),
  })
  const claims = tokens.claims()
  if (!claims.email_verified) {
    throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Google บอกว่าอีเมลยังไม่ verified — sign in with a verified Google account')
  }
  const tenant = await tenants.upsertFromGoogle({
    sub:           claims.sub,
    email:         claims.email,
    emailVerified: claims.email_verified,
    name:          claims.name,
    picture:       claims.picture,
  })
  const { token, expiresAt } = await userSessions.createUserSession(tenant.id)
  setSessionCookie(res, USER_COOKIE, token, expiresAt)
  res.clearCookie('oidc_state',        { path: '/' })
  res.clearCookie('oidc_code_verifier', { path: '/' })
  res.clearCookie('oidc_return_to',     { path: '/' })
  res.redirect(readCookie(req, 'oidc_return_to') || '/')
}))

// Public-user session lookups (consumed by UserAuthContext on the frontend).
auth.post('/user/logout', asyncHandler(async (req, res) => {
  const token = readCookie(req, USER_COOKIE)
  if (token) await userSessions.destroyUserSession(token)
  res.clearCookie(USER_COOKIE, { path: '/' })
  res.json({ ok: true })
}))

auth.get('/user/me', asyncHandler(async (req, res) => {
  const token = readCookie(req, USER_COOKIE)
  if (!token) return res.status(204).end()
  const session = await userSessions.findUserSession(token)
  if (!session) return res.status(204).end()
  res.json({
    id:      session.tenant_id,
    email:   session.email,
    name:    session.full_name,
    picture: session.picture_url,
    role:    'tenant',
  })
}))

// ───────────────────────────── Azure OIDC (admin) ────────────────────────────
//
// Same flow as Google — OIDC is OIDC. The tenant gate is enforced by Azure
// itself (single-tenant Entra ID): any user from the configured tenant is
// allowed in. If you need a finer-grained allow-list later, filter on the
// returned `email` claim here.

auth.get('/azure/start', asyncHandler(async (req, res) => {
  const client = azureClient()
  if (!client) {
    return res.status(503).json({
      ok: false,
      error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'Microsoft sign-in is not configured yet' },
    })
  }
  const returnTo = sanitizeReturn(req.query.return)
  const state = oidc.randomState()
  const codeVerifier = oidc.randomPKCECodeVerifier()
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier)
  const authUrl = oidc.buildAuthorizationUrl(client, {
    redirect_uri:           process.env.AZURE_REDIRECT_URI,
    scope:                  'openid profile email',
    state,
    code_challenge:         codeChallenge,
    code_challenge_method:  'S256',
  })
  oidcCookieStore.set(res, req)('oidc_state', state)
  oidcCookieStore.set(res, req)('oidc_code_verifier', codeVerifier)
  oidcCookieStore.set(res, req)('oidc_return_to', returnTo)
  flushOidcCookies(req, res)
  res.redirect(authUrl.href)
}))

auth.get('/azure/callback', asyncHandler(async (req, res) => {
  const client = azureClient()
  if (!client) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Microsoft sign-in is not configured yet')

  const currentUrl = new URL(req.originalUrl, `${req.protocol}://${req.headers.host}`)
  const tokens = await oidc.authorizationCodeGrant(client, currentUrl, {
    expectedState:    readCookie(req, 'oidc_state'),
    pkceCodeVerifier: readCookie(req, 'oidc_code_verifier'),
  })
  const claims = tokens.claims()
  // Azure's stable per-user id is the 'oid' claim. Falls back to 'sub' in
  // single-tenant flows but 'oid' is what Azure documentation recommends.
  const oid  = claims.oid || claims.sub
  const admin = await admins.upsertFromAzure({
    oid,
    email: claims.email || claims.preferred_username,
    name:  claims.name,
  })
  const { token, expiresAt } = await admins.createSession(admin.id)
  await admins.touchLastLogin(admin.id)
  setSessionCookie(res, ADMIN_COOKIE, token, expiresAt)
  res.clearCookie('oidc_state',         { path: '/' })
  res.clearCookie('oidc_code_verifier', { path: '/' })
  res.clearCookie('oidc_return_to',     { path: '/' })
  res.redirect(readCookie(req, 'oidc_return_to') || '/admin')
}))

// ───────────────────────────── Mock login (dev only) ────────────────────────
//
// Persona-based login for demos / local dev. Two seeded personas:
//   - tenant   → tenants.id   = MOCK_TENANT_ID  (default 1)
//   - landlord → landlords.id = MOCK_LANDLORD_ID (default 1)
//
// Gated by config.MOCK_AUTH === 'true'. Returns 404 in prod so attackers
// can't even confirm the route exists. CSRF protection: requires JSON
// Content-Type and an Origin header matching the CORS allow-list (the same
// list app.js uses for CORS).

const mockLoginBody = z.object({
  persona: z.enum(['tenant', 'landlord']),
})

auth.post('/mock/login', validate({ body: mockLoginBody }), asyncHandler(async (req, res) => {
  // Hide the route's existence in prod (when the feature flag is off).
  if (config.MOCK_AUTH !== 'true') {
    return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } })
  }
  // CSRF: require JSON body + matching origin. Browsers send
  // application/x-www-form-urlencoded for simple form POSTs, which we reject
  // here as a defense-in-depth check on top of CORS.
  const ct = String(req.headers['content-type'] || '').toLowerCase()
  if (!ct.includes('application/json')) return res.status(415).end()
  if (!originMatchesCORS(req)) return res.status(403).json({
    ok: false, error: { code: 'ORIGIN_BLOCKED', message: 'Origin not allowed' },
  })

  const { persona } = req.body
  if (persona === 'tenant') {
    const { token, expiresAt } = await userSessions.createUserSession(Number(config.MOCK_TENANT_ID || 1))
    setSessionCookie(res, USER_COOKIE, token, expiresAt)
  } else {
    const { token, expiresAt } = await landlordSessions.createLandlordSession(Number(config.MOCK_LANDLORD_ID || 1))
    setSessionCookie(res, LANDLORD_COOKIE, token, expiresAt)
  }
  res.json({ ok: true, persona })
}))

// ───────────────────────── Landlord session lookups ─────────────────────────

auth.get('/landlord/me', asyncHandler(async (req, res) => {
  const token = readCookie(req, LANDLORD_COOKIE)
  if (!token) return res.status(204).end()
  const session = await landlordSessions.findLandlordSession(token)
  if (!session) return res.status(204).end()
  res.json({
    id:      session.landlord_id,
    name:    session.full_name,
    email:   session.email,
    phone:   session.phone,
    lineId:  session.line_id,
    company: session.company_name,
    role:    'landlord',
  })
}))

auth.post('/landlord/logout', asyncHandler(async (req, res) => {
  const token = readCookie(req, LANDLORD_COOKIE)
  if (token) await landlordSessions.destroyLandlordSession(token)
  res.clearCookie(LANDLORD_COOKIE, { path: '/' })
  res.json({ ok: true })
}))