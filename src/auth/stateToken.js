// src/auth/stateToken.js — HMAC-signed, self-contained OAuth "state" token.
//
// Carries arbitrary JSON (role, return path, issued-at) through the provider
// redirect *inside the `state` parameter*, which the provider echoes back to
// the callback unchanged. The callback verifies the HMAC to confirm the value
// was minted by us — no cookie round-trip required.
//
// WHY: the alternative — storing state in a SameSite=Lax cookie set during the
// redirect chain (app → backend/start → provider → backend/callback) — gets
// dropped by iOS Safari's Intelligent Tracking Prevention (and any browser with
// strict third-party-cookie blocking), surfacing as an `AUTH_BAD_STATE` /
// "state mismatch" failure that only repro's on mobile. A self-contained signed
// token removes the cookie dependency entirely and works on every browser.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

const ENC = 'base64url'
const MAX_AGE_MS = 10 * 60 * 1000 // 10 min — matches the old cookie expiry window

/**
 * HMAC key. Prefer a dedicated OAUTH_STATE_SECRET; fall back to the Line channel
 * secret so enabling Line Login needs no extra env (it is already required and
 * server-side). Either way the key never leaves the server.
 */
function key() {
  const k = config.OAUTH_STATE_SECRET || config.LINE_LOGIN_CHANNEL_SECRET
  if (!k) throw new Error('OAUTH_STATE_SECRET (or LINE_LOGIN_CHANNEL_SECRET) is required to sign OAuth state')
  return k
}

/**
 * Sign a JSON-serialisable payload into a `body.mac` token safe for a URL param.
 * @returns {string}
 */
export function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString(ENC)
  const mac  = createHmac('sha256', key()).update(body).digest(ENC)
  return `${body}.${mac}`
}

/**
 * Verify a token and return its payload, or null if the signature is wrong /
 * missing / stale. `iat` (ms epoch) is enforced when present so a captured state
 * can't be replayed after MAX_AGE_MS.
 * @param {unknown} token
 * @returns {object|null}
 */
export function verifyState(token) {
  if (typeof token !== 'string' || !token) return null
  const sep = token.lastIndexOf('.')
  if (sep <= 0) return null
  const body = token.slice(0, sep)
  const mac  = token.slice(sep + 1)
  if (!body || !mac) return null

  const expected = createHmac('sha256', key()).update(body).digest(ENC)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let payload
  try {
    payload = JSON.parse(Buffer.from(body, ENC).toString('utf8'))
  } catch {
    return null
  }
  if (payload && typeof payload.iat === 'number' && Date.now() - payload.iat > MAX_AGE_MS) {
    return null
  }
  return payload
}
