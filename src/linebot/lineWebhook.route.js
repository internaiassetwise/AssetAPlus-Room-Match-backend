// src/linebot/lineWebhook.route.js — Public POST /api/line/webhook entry.
//
// Phase 1 responsibilities:
//   1. Verify the X-Line-Signature header (HMAC-SHA256 over raw body).
//   2. Persist every event to line_webhook_log.
//   3. Return 200 OK fast — Line treats non-2xx as retryable, which would flood us.
//
// Phase 2+ will add `handleEvent` dispatch (text → chatAgent, image → upload
// handler, follow → onboarding). The shape of this file is stable; only the
// dispatch logic in lineWebhook.service.js grows.
//
// The route sits OUTSIDE the normal apiRouter guard (no requireAdmin,
// no requireUser) because Line is an external service that authenticates
// itself via the channel secret, not via session cookies.

import { Router } from 'express'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { verifySignature, handleEvent, isConfigured } from './lineWebhook.service.js'

const router = Router()

/**
 * GET /api/line/webhook — Line's webhook verification handshake.
 * Just respond 200 so the console accepts the URL.
 */
router.get('/', (_req, res) => {
  res.status(200).json({ ok: true, service: 'line-webhook' })
})

/**
 * POST /api/line/webhook — real event stream.
 *
 * Response contract (per Line docs):
 *   200 OK → "we got it, don't retry"
 *   any non-2xx → Line retries up to 3× with exponential back-off
 *
 * So: signature failure → 401 (Line won't retry but we'll never get an
 * inbound event anyway; logged so we can investigate). Missing config → 503
 * (Line retries, but that's fine — once the secret is set we start receiving).
 */
router.post('/', async (req, res) => {
  if (!isConfigured()) {
    logger.warn('line webhook hit but LINE_CHANNEL_SECRET is not set; returning 503')
    return res.status(503).json({
      ok: false,
      error: { code: 'LINE_NOT_CONFIGURED', message: 'Channel secret is not configured' },
    })
  }

  const sig = req.headers['x-line-signature']
  if (!verifySignature(req.rawBody, sig)) {
    logger.warn(
      { hasSig: Boolean(sig), bodyLen: req.rawBody?.length },
      'line webhook signature mismatch',
    )
    return res.status(401).json({
      ok: false,
      error: { code: 'LINE_SIGNATURE_INVALID', message: 'Invalid X-Line-Signature' },
    })
  }

  // Fire-and-forget: enqueue per-event dispatch and ack Line IMMEDIATELY.
  // handleEvent only enqueues (per-user serialized, globally capped) and
  // returns; the actual Gemini/tool work happens in the background. We must NOT
  // await it — holding the HTTP open through the LLM round-trip would make Line
  // retry under load and cause duplicate processing. handleEvent + the queue
  // swallow their own errors; the .catch is a final safety net.
  handleEvent(req.body).catch((err) => {
    logger.error({ err }, 'line webhook enqueue failed')
  })

  res.status(200).json({ ok: true })
})

export default router