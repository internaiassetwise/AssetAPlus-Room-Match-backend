// src/middleware/rateLimit.js — Tiny in-memory fixed-window rate limiter.
//
// WHY no `express-rate-limit`: the project rule is no new npm packages, so this
// is a self-contained middleware (~30 lines). State is per-process, which is
// fine for Railway's single-replica deploys; if you scale to multiple instances,
// move this to a shared store (Redis).
//
// Requires `app.set('trust proxy', 1)` so req.ip is the real client behind the
// Railway proxy (already set in app.js).

import { AppError } from './AppError.js'

const SWEEP_INTERVAL_MS = 60_000

/**
 * @param {object} opts
 * @param {number} opts.windowMs  Window length (ms).
 * @param {number} opts.max       Max requests per key per window.
 * @param {(req)=>string} [opts.keyFn]  Override the bucket key (default req.ip).
 * @param {string}  [opts.message]  Thai message returned on 429.
 */
export function rateLimit({ windowMs, max, keyFn, message } = {}) {
  const buckets = new Map()   // key -> { count, resetAt }

  // Lazy periodic cleanup so the map can't grow unbounded from unique IPs.
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k)
  }, Math.min(SWEEP_INTERVAL_MS, Math.max(windowMs, 1000)))
  sweep.unref?.()

  return function rateLimitMiddleware(req, res, next) {
    const key = (keyFn ? keyFn(req) : req.ip) || 'unknown'
    const now = Date.now()
    let b = buckets.get(key)
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs }
      buckets.set(key, b)
    }
    b.count += 1
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)))
      return next(new AppError(429, 'RATE_LIMITED',
        message || 'พยายามเร็วเกินไป กรุณาลองอีกครั้งในอีกสักครู่'))
    }
    next()
  }
}
