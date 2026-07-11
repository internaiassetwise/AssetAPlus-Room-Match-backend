// src/middleware/requireBot.js — Server-to-server auth for the Line bot.
//
// The .NET chat bot (asw-roommatchbot-api) authenticates to Express by
// sending `X-Bot-Secret: <BOT_SHARED_SECRET>`. We compare it (constant-time)
// against the env var. If it matches, the request is treated as if from a
// trusted internal service — i.e. it can bypass the user-facing CONTACT_ADMIN
// gate on POST /my-listings and POST /viewings, and it can call admin-only
// routes like POST /my-listings/:id/photos.
//
// The middleware attaches `req.bot = { lineUserId, landlordLineUserId }` so
// downstream handlers can persist the bot caller (e.g. "created from Line
// chat by U…") for auditing.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from './AppError.js'

export const BOT_SECRET_HEADER = 'x-bot-secret'

/**
 * Constant-time compare that does NOT leak the secret's length: HMAC both
 * values to equal-length digests, then timingSafeEqual those. (A direct
 * timingSafeEqual on raw strings would still need a length pre-check.)
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  const mac = (s) => createHmac('sha256', s).update('roommatch-requirebot').digest()
  try {
    return timingSafeEqual(mac(a), mac(b))
  } catch {
    return false
  }
}

export function requireBot(req, _res, next) {
  const expected = process.env.BOT_SHARED_SECRET
  if (!expected) {
    return next(new AppError(500, 'BOT_NOT_CONFIGURED', 'BOT_SHARED_SECRET is not set on the server'))
  }
  const given = req.headers[BOT_SECRET_HEADER]
  if (!given || !safeEqual(given, expected)) {
    return next(new AppError(401, 'BOT_UNAUTHORIZED', 'Invalid X-Bot-Secret'))
  }
  req.bot = {
    lineUserId:         req.headers['x-bot-lineuserid']    || null,
    landlordLineUserId: req.headers['x-bot-landlordlineuserid'] || null,
  }
  next()
}