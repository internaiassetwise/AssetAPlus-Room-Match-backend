// src/linebot/lineDebug.route.js — Dev-only route for manually testing the
// Line messaging pipeline against a real Line account.
//
// Mounted at /api/line/debug/* in dev/staging. **Refuses to mount in
// production** (see routes/index.js). All endpoints are no-ops (404) if
// the Line credentials are not set.
//
// Endpoints:
//   POST /api/line/debug/push
//     body: { lineUserId, text }             → sends a single text message
//     body: { lineUserId, messages: [...] }  → sends arbitrary Line messages
//   POST /api/line/debug/profile
//     body: { lineUserId }                    → resolves a user's profile
//   POST /api/line/debug/reply-token
//     body: { replyToken, text }              → exercises replyMessage()
//   GET  /api/line/debug/profile-cache
//                                              → shows the in-process cache
//
// These are not load-bearing features — they exist so we can verify the
// outbound channel after each deployment without having to wait for a
// real user to message the bot.

import { Router } from 'express'
import { z } from 'zod'
import { isProd, config } from '../config.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { AppError }     from '../middleware/AppError.js'
import * as line from './lineMessaging.service.js'

export const lineDebug = Router()

// Debug routes can push arbitrary Line messages / drive the agent as any user,
// so they're disabled unless BOTH (a) not production AND (b) explicitly opted-in
// via ENABLE_LINE_DEBUG=true — protects any publicly-reachable staging deploy.
if (isProd || config.ENABLE_LINE_DEBUG !== 'true') {
  // Mount a single 404 so the route shape is consistent (the URL still exists)
  // but nothing works.
  lineDebug.all('/*', (_req, _res, next) => {
    next(new AppError(404, 'LINE_DEBUG_DISABLED',
      'debug routes are disabled (set ENABLE_LINE_DEBUG=true in a non-prod env)'))
  })
} else {
  // ----- push ------------------------------------------------------------
  const pushTextBody = z.object({
    lineUserId: z.string().min(1).max(64),
    text:       z.string().min(1).max(5000),
  })
  const pushMsgsBody = z.object({
    lineUserId: z.string().min(1).max(64),
    messages:   z.array(z.object({}).passthrough()).min(1).max(5),
  })

  lineDebug.post('/push', validate({ body: pushTextBody }),
    asyncHandler(async (req, res) => {
      if (!line.isConfigured()) {
        throw new AppError(503, 'LINE_NOT_CONFIGURED',
          'LINE_CHANNEL_ACCESS_TOKEN is not set')
      }
      const out = await line.pushMessage(req.body.lineUserId, {
        type: 'text',
        text: req.body.text,
      })
      res.json({ ok: true, result: out })
    }),
  )

  lineDebug.post('/push-messages', validate({ body: pushMsgsBody }),
    asyncHandler(async (req, res) => {
      if (!line.isConfigured()) {
        throw new AppError(503, 'LINE_NOT_CONFIGURED',
          'LINE_CHANNEL_ACCESS_TOKEN is not set')
      }
      const out = await line.pushMessage(req.body.lineUserId, req.body.messages)
      res.json({ ok: true, result: out })
    }),
  )

  // ----- reply (requires a real replyToken from a real inbound event) ----
  const replyBody = z.object({
    replyToken: z.string().min(1).max(64),
    text:       z.string().min(1).max(5000),
  })
  lineDebug.post('/reply-token', validate({ body: replyBody }),
    asyncHandler(async (req, res) => {
      if (!line.isConfigured()) {
        throw new AppError(503, 'LINE_NOT_CONFIGURED',
          'LINE_CHANNEL_ACCESS_TOKEN is not set')
      }
      const out = await line.replyMessage(req.body.replyToken, {
        type: 'text',
        text: req.body.text,
      })
      res.json({ ok: true, result: out })
    }),
  )

  // ----- profile ---------------------------------------------------------
  const profileBody = z.object({
    lineUserId: z.string().min(1).max(64),
  })
  lineDebug.post('/profile', validate({ body: profileBody }),
    asyncHandler(async (req, res) => {
      if (!line.isConfigured()) {
        throw new AppError(503, 'LINE_NOT_CONFIGURED',
          'LINE_CHANNEL_ACCESS_TOKEN is not set')
      }
      const profile = await line.getProfile(req.body.lineUserId)
      res.json({ ok: true, profile })
    }),
  )

  // ----- cache introspection (read-only) --------------------------------
  // Just for visibility during dev. The cache is exported on the service
  // module so we can peek at it via an internal endpoint.
  lineDebug.get('/profile-cache', (_req, res) => {
    res.json({ ok: true, cache: line._profileCacheSnapshot?.() ?? null })
  })

  lineDebug.post('/profile-cache/clear', (_req, res) => {
    line._clearProfileCache()
    res.json({ ok: true })
  })

  // ----- agent (exercise the function-calling loop; no real Line needed) ----
  // Dry-run by default: runs the full agent loop + persists chat_sessions, but
  // does NOT push to Line. Set body.push=true to also deliver via the real
  // outbound path (requires a valid lineUserId + configured Line creds).
  // Used to verify Phase 4 tool flows with curl, independent of the webhook.
  const agentBody = z.object({
    lineUserId: z.string().min(1).max(64),
    text:       z.string().min(1).max(5000),
    push:       z.boolean().default(false),
  })
  lineDebug.post('/agent', validate({ body: agentBody }),
    asyncHandler(async (req, res) => {
      const { handle, runOnce } = await import('./chatAgent.service.js')
      const { lineUserId, text, push } = req.body
      if (push) {
        const result = await handle(lineUserId, text)
        return res.json({ ok: true, mode: 'push', result })
      }
      const result = await runOnce(lineUserId, text)
      res.json({ ok: true, mode: 'dry-run', result })
    }),
  )

  // ----- postback (exercise a postback action without a real Line webhook) --
  // Used to test slot booking: { lineUserId, data: "action=book&slotId=5" }.
  const postbackBody = z.object({
    lineUserId: z.string().min(1).max(64),
    data:       z.string().min(1).max(500),
  })
  lineDebug.post('/postback', validate({ body: postbackBody }),
    asyncHandler(async (req, res) => {
      const { handlePostback } = await import('./lineWebhook.service.js')
      await handlePostback(req.body.lineUserId, req.body.data)
      res.json({ ok: true })
    }),
  )
}
