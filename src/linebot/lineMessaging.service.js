// src/linebot/lineMessaging.service.js — Thin wrapper around the Line
// Messaging API. Used by the chat agent (Phase 3+) to reply to users and
// by landlord flows to upload photos (Phase 4).
//
// We call the Line REST endpoints directly (no SDK) — the bot only needs
// five surfaces:
//   1. pushMessage(userId, messages)      → outbound proactive message
//   2. replyMessage(replyToken, messages) → reply in the same conversation
//   3. getProfile(userId)                 → displayName + pictureUrl
//   4. downloadImage(messageId)           → bytes of an image the user sent
//   5. startLoading(userId, seconds)      → shows "typing…" in Line
//
// The plan referenced an "OAuth token cache" — that's a leftover from a
// short-lived-token design. The env ships a long-lived channel access
// token (LINE_CHANNEL_ACCESS_TOKEN), so we just send it as a static
// Bearer header. No rotation, no refresh.
//
// Every successful push/reply also appends a row to line_reply_log so the
// admin's /admin/inbox can show "what we said back to the user" alongside
// the inbound log. Both writes are best-effort — they're diagnostic, never
// load-bearing. A failed log write must not throw.

import { config } from '../config.js'
import { logger } from '../logger.js'
import { appendReply } from '../db/repositories/lineLogs.repo.js'
import { AppError } from '../middleware/AppError.js'

const TIMEOUT_MS = 15_000

const isConfigured = () =>
  Boolean(config.LINE_CHANNEL_ACCESS_TOKEN && config.LINE_CHANNEL_SECRET)

function authHeader() {
  return { Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}` }
}

function isLineErrorStatus(status) {
  // 4xx is "we sent something Line rejected" (bad payload, wrong audience).
  // 5xx is "Line is having a bad day" — retry, with backoff upstream.
  return status >= 400
}

/**
 * Low-level Line API request — auth headers, JSON body, timeout, error
 * normalisation. Returns parsed JSON on 2xx. Throws AppError on non-2xx.
 *
 * @param {string} baseUrl  Either API or DATA base (different host).
 * @param {string} path     e.g. "/message/push"
 * @param {object} [opts]
 * @param {string} [opts.method]      GET / POST
 * @param {object} [opts.body]        JSON-serialised
 * @param {boolean}[opts.rawResponse] If true, return the raw Response (downloadImage).
 */
async function lineFetch(baseUrl, path, { method = 'POST', body, rawResponse = false } = {}) {
  if (!isConfigured()) {
    throw new AppError(503, 'LINE_NOT_CONFIGURED',
      'Line credentials are not configured')
  }

  const url = `${baseUrl}${path}`
  let resp
  try {
    resp = await fetch(url, {
      method,
      headers: {
        ...authHeader(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    // fetch() throws AbortError on timeout, ECONNRESET etc. Treat as 502.
    logger.error({ err, url }, 'line fetch transport error')
    throw new AppError(502, 'LINE_TRANSPORT_ERROR',
      'ไม่สามารถติดต่อ Line Messaging API ได้ในขณะนี้')
  }

  if (isLineErrorStatus(resp.status)) {
    const text = await resp.text().catch(() => '')
    logger.error(
      { status: resp.status, url, body: text.slice(0, 500) },
      'line api error',
    )
    if (resp.status === 401 || resp.status === 403) {
      throw new AppError(502, 'LINE_AUTH_ERROR',
        'Line channel credentials are invalid or revoked')
    }
    if (resp.status === 429) {
      throw new AppError(429, 'LINE_RATE_LIMITED',
        'Line rate-limit hit — please try again later')
    }
    throw new AppError(502, 'LINE_API_ERROR',
      'Line Messaging API ตอบกลับด้วยข้อผิดพลาด', { status: resp.status })
  }

  if (rawResponse) return resp
  // 2xx with an empty body is normal for /message/reply and /chat/loading/start.
  if (resp.status === 204) return null
  const ct = resp.headers.get('content-type') || ''
  if (ct.includes('application/json')) return resp.json()
  return resp.text()
}

/**
 * Proactive push — send 1..5 messages to a user (no replyToken needed).
 *
 * @param {string} lineUserId
 * @param {object[]|object} messages  1-5 Line message objects
 * @returns {Promise<object|null>}    null on 204, or Line's JSON envelope
 */
export async function pushMessage(lineUserId, messages) {
  const msgs = Array.isArray(messages) ? messages : [messages]
  if (msgs.length === 0 || msgs.length > 5) {
    throw new AppError(400, 'LINE_BAD_PAYLOAD',
      'pushMessage accepts 1–5 messages')
  }
  const result = await lineFetch(config.LINE_API_BASE_URL, '/message/push', {
    method: 'POST',
    body: { to: lineUserId, messages: msgs },
  })
  // Append to reply log (best-effort).
  await appendReply({ lineUserId, replyToken: null, message: { kind: 'push', messages: msgs } })
  return result
}

/**
 * Reply within the same conversation — uses the replyToken from the inbound
 * event. Tokens are single-use and expire in ~30s, so call this as part of
 * the webhook hot path.
 *
 * @param {string} replyToken
 * @param {object[]|object} messages
 */
export async function replyMessage(replyToken, messages) {
  if (!replyToken) {
    throw new AppError(400, 'LINE_NO_REPLY_TOKEN',
      'replyMessage requires a non-empty replyToken')
  }
  const msgs = Array.isArray(messages) ? messages : [messages]
  const result = await lineFetch(config.LINE_API_BASE_URL, '/message/reply', {
    method: 'POST',
    body: { replyToken, messages: msgs },
  })
  await appendReply({ lineUserId: null, replyToken, message: { kind: 'reply', messages: msgs } })
  return result
}

/**
 * Best-effort delivery that prefers a FREE replyMessage (uses the webhook reply
 * token — NOT counted against the monthly push quota) and falls back to a
 * metered pushMessage only when there's no token or the reply failed (e.g.
 * token expired). Swallows errors so a delivery failure never throws — the bot
 * must stay alive even when the push quota is exhausted.
 *
 * Use this everywhere a webhook event triggers an outbound user message, so the
 * message rides the free reply path instead of burning push quota.
 */
export async function replyOrPush(lineUserId, replyToken, messages) {
  const msgs = (Array.isArray(messages) ? messages : [messages])
    .map((m) => (typeof m === 'string' ? { type: 'text', text: m } : m))
    .filter(Boolean)
  if (msgs.length === 0) return
  if (!isConfigured()) return
  if (replyToken) {
    try {
      await replyMessage(replyToken, msgs.slice(0, 5))
      for (const m of msgs.slice(5)) {
        try { await pushMessage(lineUserId, m) } catch (err) { logger.error({ err, lineUserId }, 'line push failed (overflow)') }
      }
      return
    } catch (err) {
      logger.warn({ err: err.message, lineUserId }, 'replyMessage failed, falling back to push')
    }
  }
  for (const m of msgs) {
    try { await pushMessage(lineUserId, m) }
    catch (err) { logger.error({ err, lineUserId }, 'line push failed') }
  }
}

/**
 * Fetch a user's profile (displayName, pictureUrl, statusMessage, language).
 * Used to personalise greetings and to record who a landlord is. Cached in
 * memory per-process for 5 minutes — Line's profile data is slow-moving.
 *
 * @param {string} lineUserId
 * @returns {Promise<{displayName: string, userId: string, language?: string, pictureUrl?: string, statusMessage?: string}>}
 */
const profileCache = new Map()        // userId → {profile, fetchedAt}
const PROFILE_TTL_MS = 5 * 60_000

export async function getProfile(lineUserId) {
  const cached = profileCache.get(lineUserId)
  if (cached && Date.now() - cached.fetchedAt < PROFILE_TTL_MS) {
    return cached.profile
  }
  const profile = await lineFetch(
    config.LINE_API_BASE_URL,
    `/profile/${encodeURIComponent(lineUserId)}`,
    { method: 'GET' },
  )
  profileCache.set(lineUserId, { profile, fetchedAt: Date.now() })
  return profile
}

/** Test-only: clear the in-process cache (used by /api/line/debug/profile-cache/clear). */
export function _clearProfileCache() {
  profileCache.clear()
}

/** Test-only: dump the cache for /api/line/debug/profile-cache. */
export function _profileCacheSnapshot() {
  return [...profileCache.entries()].map(([userId, v]) => ({
    userId,
    fetchedAt: v.fetchedAt,
    displayName: v.profile?.displayName,
  }))
}

/**
 * Download an image the user sent. Returns the raw bytes + content-type so
 * the caller can write to disk or stream to a CDN.
 *
 * @param {string} messageId  from `event.message.id` of an image-type message
 * @returns {Promise<{buffer: Buffer, contentType: string, filename?: string}>}
 */
export async function downloadImage(messageId) {
  if (!messageId) {
    throw new AppError(400, 'LINE_NO_MESSAGE_ID',
      'downloadImage requires a non-empty messageId')
  }
  const resp = await lineFetch(
    config.LINE_DATA_BASE_URL,
    `/message/${encodeURIComponent(messageId)}/content`,
    { method: 'GET', rawResponse: true },
  )
  const buffer = Buffer.from(await resp.arrayBuffer())
  const contentType = resp.headers.get('content-type') || 'application/octet-stream'
  const cd = resp.headers.get('content-disposition') || ''
  const filename = cd.match(/filename="?([^";]+)"?/i)?.[1]
  return { buffer, contentType, filename }
}

/**
 * Show a "typing…" indicator in the user's Line chat. Useful before any
 * agent call that takes more than a second (LLM, pgvector search). The
 * indicator auto-clears after `seconds` (5–60). Single-use per request.
 *
 * @param {string} lineUserId
 * @param {number} [seconds=20]  5–60
 */
export async function startLoading(lineUserId, seconds = 20) {
  const s = Math.min(60, Math.max(5, seconds | 0))
  return await lineFetch(config.LINE_API_BASE_URL, '/chat/loading/start', {
    method: 'POST',
    body: { chatId: lineUserId, loadingSeconds: s },
  })
}

export { isConfigured }
