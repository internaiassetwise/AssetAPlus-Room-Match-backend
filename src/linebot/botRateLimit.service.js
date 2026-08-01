// src/linebot/botRateLimit.service.js — Per-user throttle for LLM-backed bot turns.
//
// WHY: every inbound text/image message runs a Gemini call (thousands of output
// tokens). Without a cap, one spammer can (a) run up an unbounded API bill and
// (b) starve real customers — the dispatch queue only runs LINE_BOT_MAX_CONCURRENT
// jobs at once, so a flood monopolises every slot.
//
// Deliberately NOT applied to cheap events (follow / postback / group chatter):
// those never touch the LLM, and throttling a booking postback would break a
// legitimate flow mid-way.
//
// In-memory on purpose — same trade-off as middleware/rateLimit.js. With one
// container this is exact; if the app is ever scaled out, each instance keeps
// its own bucket, so the effective ceiling multiplies by the instance count.
// That is still a bound (the point is stopping runaway cost), but if we scale
// horizontally this should move to Postgres or Redis.

import { config } from '../config.js'
import { logger } from '../logger.js'

const buckets = new Map()   // lineUserId -> { count, resetAt, warned }

/** Drop buckets whose window has passed, so the Map can't grow without bound. */
const sweep = setInterval(() => {
  const now = Date.now()
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k)
  }
}, 10 * 60_000)
sweep.unref()

/**
 * Consume one token for this user.
 *
 * @param {string} lineUserId
 * @returns {{allowed: boolean, warn: boolean, retryAfterSec: number}}
 *   allowed — process this message normally
 *   warn    — first rejection in this window; tell the user once (never spam them)
 */
export function consume(lineUserId) {
  const max      = config.LINE_BOT_RATE_MAX
  const windowMs = config.LINE_BOT_RATE_WINDOW_MS
  if (!lineUserId || max <= 0) return { allowed: true, warn: false, retryAfterSec: 0 }

  const now = Date.now()
  let b = buckets.get(lineUserId)
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs, warned: false }
    buckets.set(lineUserId, b)
  }

  b.count++
  if (b.count <= max) return { allowed: true, warn: false, retryAfterSec: 0 }

  const warn = !b.warned
  b.warned = true
  const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - now) / 1000))
  if (warn) {
    logger.warn({ lineUserId, count: b.count, max, retryAfterSec }, 'line bot rate limit hit')
  }
  return { allowed: false, warn, retryAfterSec }
}

/**
 * Clear a user's budget immediately.
 *
 * Called when an admin takes over or hands the chat back: a human has looked at
 * this person and decided they are a real customer, so the anti-abuse counter
 * must not outlive that judgement. Without this, closing a ticket inside the
 * window left the bot silently ignoring the customer for the remainder — and
 * silently, since the one-time hand-off notice had already been spent.
 *
 * @param {string} lineUserId
 * @returns {boolean} true if a bucket was actually cleared
 */
export function reset(lineUserId) {
  if (!lineUserId) return false
  const had = buckets.delete(lineUserId)
  if (had) logger.info({ lineUserId }, 'line bot rate limit reset (admin handled)')
  return had
}

/** Test/debug helper. */
export function _snapshot() {
  return { tracked: buckets.size, max: config.LINE_BOT_RATE_MAX, windowMs: config.LINE_BOT_RATE_WINDOW_MS }
}
