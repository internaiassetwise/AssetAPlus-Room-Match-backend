// src/routes/adminInbox.js — Admin inbox over admin_queue (Phase 5).
//
// Everything the bot escalates (FAQ misses, edit-description requests,
// upload-photos with no draft, viewings to confirm, system errors) lands in
// admin_queue. Admin reads it here, replies, and the reply is pushed straight
// to the user's Line IN-PROCESS (via lineMessaging) — no separate bot hop and
// no removed ROOM_MATCH_BOT_URL/BOT_SHARED_SECRET (the old bot-inquiries reply
// path was dead).
//
//   GET  /api/admin/inbox             (admin) → { items, summary, limit, offset }
//   GET  /api/admin/inbox/summary     (admin) → { open, replied, resolved }
//   GET  /api/admin/inbox/:id         (admin)
//   POST /api/admin/inbox/:id/reply   (admin) → push to user's Line + mark replied
//   POST /api/admin/inbox/:id/resolve (admin) → close without replying

import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/adminQueue.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { AppError }     from '../middleware/AppError.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { logger } from '../logger.js'
import * as lineMessaging from '../linebot/lineMessaging.service.js'

export const adminInbox = Router()

const idParam   = z.object({ id: z.coerce.number().int().positive() })
const replyBody = z.object({ reply: z.string().trim().min(1).max(2000) })

adminInbox.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' && req.query.status !== 'all'
    ? req.query.status : null
  const limit  = Math.min(200, Math.max(1, Number(req.query.limit)  || 100))
  const offset = Math.max(0, Number(req.query.offset) || 0)
  const [items, summary] = await Promise.all([
    repo.list({ status, limit, offset }),
    repo.countByStatus(),
  ])
  res.json({ items, summary, limit, offset })
}))

adminInbox.get('/summary', requireAdmin, asyncHandler(async (_req, res) => {
  res.json(await repo.countByStatus())
}))

adminInbox.get('/:id', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const row = await repo.findById(req.params.id)
    if (!row) throw new AppError(404, 'INQUIRY_NOT_FOUND', 'ไม่พบรายการนี้')
    res.json(row)
  }),
)

adminInbox.post('/:id/reply', requireAdmin,
  validate({ params: idParam, body: replyBody }),
  asyncHandler(async (req, res) => {
    const item = await repo.findById(req.params.id)
    if (!item) throw new AppError(404, 'INQUIRY_NOT_FOUND', 'ไม่พบรายการนี้')
    if (item.status !== 'open') {
      throw new AppError(409, 'ALREADY_HANDLED', `รายการนี้ถูกจัดการแล้ว (status=${item.status})`)
    }

    // Push the reply to the user's Line directly. If Line isn't reachable we
    // do NOT mark the item replied — the admin sees the error and can retry
    // (the client keeps the typed text on failure).
    if (lineMessaging.isConfigured()) {
      try {
        await lineMessaging.pushMessage(item.lineUserId, { type: 'text', text: req.body.reply })
      } catch (err) {
        logger.error({ err, id: item.id, lineUserId: item.lineUserId }, 'inbox reply push failed')
        throw new AppError(502, 'LINE_PUSH_FAILED',
          'ส่งข้อความไปยัง Line ไม่สำเร็จ กรุณาลองอีกครั้ง')
      }
    }

    const updated = await repo.markReplied(item.id, { adminReply: req.body.reply })
    res.json(updated)
  }),
)

adminInbox.post('/:id/resolve', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const item = await repo.findById(req.params.id)
    if (!item) throw new AppError(404, 'INQUIRY_NOT_FOUND', 'ไม่พบรายการนี้')
    if (item.status === 'resolved') return res.json(item)
    res.json(await repo.markResolved(item.id))
  }),
)
