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
import { randomUUID } from 'node:crypto'
import * as oidc from 'openid-client'
import * as admins           from '../db/repositories/admins.repo.js'
import * as tenants          from '../db/repositories/tenants.repo.js'
import * as landlords        from '../db/repositories/landlords.repo.js'
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
import { logger } from '../logger.js'

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

// ─────────────────────────── Line Login (public users) ──────────────────────
//
// One LINE Login channel serves BOTH tenants and landlords (and the LIFF listing
// form). Flow:
//   GET /auth/line/start?role=tenant|landlord&return=/path
//     → 302 to Line's consent screen (state + role + return in short-lived cookies)
//   GET /auth/line/callback?code=&state=
//     → exchange code → fetch Line profile → findByLineId in BOTH tables → set
//       user_session and/or landlord_session (a user can hold both roles) → redirect.
//
// The ?role= hint only decides which stub to seed for a BRAND-NEW user (no row in
// either table). Returning users get a session for every role they already have,
// so a landlord who also rents sees both portals after one login.

const LINE_AUTHORIZE_URL = 'https://access.line.me/oauth2/v2.1/authorize'
const LINE_TOKEN_URL     = 'https://api.line.me/oauth2/v2.1/token'
const LINE_PROFILE_URL   = 'https://api.line.me/v2/profile'

function lineLoginConfigured() {
  return !!(config.LINE_LOGIN_CHANNEL_ID && config.LINE_LOGIN_CHANNEL_SECRET && config.LINE_LOGIN_REDIRECT_URI)
}

/**
 * Build an absolute URL on the FRONTEND origin (the React app), used for the
 * post-OAuth redirect. The callback runs on the backend origin, so a relative
 * redirect would land on the API instead of the app. Falls back to a relative
 * path when no web origin is configured (same-origin deploys).
 */
function frontendUrl(path) {
  const origin = (config.WEB_BASE_URL || config.APP_BASE_URL || '').replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return origin ? `${origin}${p}` : p
}

auth.get('/line/start', asyncHandler(async (req, res) => {
  if (!lineLoginConfigured()) {
    return res.status(503).json({
      ok: false,
      error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'Line Login is not configured yet' },
    })
  }
  const role     = req.query.role === 'landlord' ? 'landlord' : 'tenant'
  const returnTo = sanitizeReturn(req.query.return)
  const state    = randomUUID()

  const authUrl = new URL(LINE_AUTHORIZE_URL)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id',     config.LINE_LOGIN_CHANNEL_ID)
  authUrl.searchParams.set('redirect_uri',  config.LINE_LOGIN_REDIRECT_URI)
  authUrl.searchParams.set('state',         state)
  // 'profile' is enough — it returns the stable userId (our line_id key) plus
  // displayName/picture via /v2/profile. We deliberately do NOT request 'email':
  // LINE gates it behind a channel permission that can need review, and we don't
  // use it (identity = line_id).
  authUrl.searchParams.set('scope',         'profile openid')
  authUrl.searchParams.set('ui_locales',    'th')

  oidcCookieStore.set(res, req)('oidc_state',     state)
  oidcCookieStore.set(res, req)('oidc_role',      role)
  oidcCookieStore.set(res, req)('oidc_return_to', returnTo)
  flushOidcCookies(req, res)
  res.redirect(authUrl.href)
}))

auth.get('/line/callback', asyncHandler(async (req, res) => {
  if (!lineLoginConfigured()) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Line Login is not configured yet')

  // CSRF: the state Line echoed back must match the one we set at /start.
  const expectedState = readCookie(req, 'oidc_state')
  if (!expectedState || req.query.state !== expectedState) {
    throw new AppError(400, 'AUTH_BAD_STATE', 'Line login state mismatch — please try again')
  }
  const role     = readCookie(req, 'oidc_role') === 'landlord' ? 'landlord' : 'tenant'
  const returnTo = readCookie(req, 'oidc_return_to') || '/'

  const clearOidc = () => {
    res.clearCookie('oidc_state',     { path: '/' })
    res.clearCookie('oidc_role',      { path: '/' })
    res.clearCookie('oidc_return_to', { path: '/' })
  }

  // User declined, or Line returned an error — bounce back to the login page.
  if (req.query.error) {
    clearOidc()
    return res.redirect(frontendUrl('/login?line_error=1'))
  }

  // Exchange the auth code for an access token (confidential client: the channel
  // secret stays server-side, so no PKCE needed).
  const tokenRes = await fetch(LINE_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'authorization_code',
      code:          req.query.code,
      redirect_uri:  config.LINE_LOGIN_REDIRECT_URI,
      client_id:     config.LINE_LOGIN_CHANNEL_ID,
      client_secret: config.LINE_LOGIN_CHANNEL_SECRET,
    }),
  })
  if (!tokenRes.ok) {
    logger.error({ status: tokenRes.status, body: await tokenRes.text().catch(() => '') }, 'line token exchange failed')
    throw new AppError(502, 'LINE_TOKEN_FAILED', 'Line login failed at token exchange')
  }
  const tokens = await tokenRes.json()

  // Fetch the stable Line userId (+ display name / picture for future use).
  const profRes = await fetch(LINE_PROFILE_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  })
  if (!profRes.ok) throw new AppError(502, 'LINE_PROFILE_FAILED', 'Line login failed at profile fetch')
  const profile = await profRes.json()
  const lineUserId = profile.userId
  if (!lineUserId) throw new AppError(502, 'LINE_NO_USER', 'Line did not return a user id')

  // Link the Line identity to tenant and/or landlord rows. A user can be both,
  // so we look in BOTH tables and set a session for every row that exists. The
  // ?role= hint only seeds a stub when the user is brand-new.
  let tenant   = await tenants.findByLineId(lineUserId)
  let landlord = await landlords.findByLineId(lineUserId)
  if (!tenant && !landlord) {
    if (role === 'landlord') landlord = await landlords.createFromBot(lineUserId)
    else                     tenant   = await tenants.createFromBot(lineUserId)
  }

  if (tenant) {
    const s = await userSessions.createUserSession(tenant.id)
    setSessionCookie(res, USER_COOKIE, s.token, s.expiresAt)
  }
  if (landlord) {
    const s = await landlordSessions.createLandlordSession(landlord.id)
    setSessionCookie(res, LANDLORD_COOKIE, s.token, s.expiresAt)
  }

  logger.info({ lineUserId, tenant: !!tenant, landlord: !!landlord }, 'line login succeeded')
  clearOidc()
  res.redirect(frontendUrl(returnTo))
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