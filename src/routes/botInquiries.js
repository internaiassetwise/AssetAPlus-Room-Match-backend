// src/routes/botInquiries.js — Admin inbox of Line bot inquiries.
//
// Flow:
//
// LEGACY page. New escalations land in admin_queue and are handled at
// /admin/inbox (routes/adminInbox.js); this router only serves rows created
// before that migration. Kept read/reply-able so old tickets can be closed out.
//
//   1. Admin opens /admin/bot-inquiries, sees the list, picks one.
//   2. Admin types a reply → pushed to the tenant's Line in-process,
//      then the row is marked replied.
//   3. Admin can also resolve without replying (e.g. duplicate).
//
// Routes:
//   GET  /api/admin/bot-inquiries              (admin)
//   GET  /api/admin/bot-inquiries/summary      (admin, badge counts)
//   GET  /api/admin/bot-inquiries/:id          (admin)
//   POST /api/admin/bot-inquiries/:id/reply    (admin)
//   POST /api/admin/bot-inquiries/:id/resolve  (admin)

import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/botInquiries.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { AppError }     from '../middleware/AppError.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import * as lineMessaging from '../linebot/lineMessaging.service.js'

export const botInquiries = Router()


const idParam = z.object({ id: z.coerce.number().int().positive() })

const replyBody = z.object({
  reply: z.string().trim().min(1).max(2000),
})

// ---------------------------------------------------------------------------
// GET — list inquiries
// ---------------------------------------------------------------------------
botInquiries.get('/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status !== 'all'
      ? req.query.status
      : null
    const limit  = Math.min(200, Math.max(1, Number(req.query.limit)  || 50))
    const offset = Math.max(0, Number(req.query.offset) || 0)
    const [items, summary] = await Promise.all([
      repo.list({ status, limit, offset }),
      repo.countByStatus(),
    ])
    res.json({ items, summary, limit, offset })
  }),
)

// ---------------------------------------------------------------------------
// GET /summary — badge counts only (cheap call the dashboard polls)
// ---------------------------------------------------------------------------
botInquiries.get('/summary',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await repo.countByStatus())
  }),
)

// ---------------------------------------------------------------------------
// GET /:id — single inquiry
// ---------------------------------------------------------------------------
botInquiries.get('/:id', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const row = await repo.findById(req.params.id)
    if (!row) throw new AppError(404, 'INQUIRY_NOT_FOUND', 'ไม่พบรายการนี้')
    res.json(row)
  }),
)

// ---------------------------------------------------------------------------
// POST /:id/reply — admin replies; push to the tenant's Line, then mark
// ---------------------------------------------------------------------------
botInquiries.post('/:id/reply',
  requireAdmin,
  validate({ params: idParam, body: replyBody }),
  asyncHandler(async (req, res) => {
    const inquiry = await repo.findById(req.params.id)
    if (!inquiry) throw new AppError(404, 'INQUIRY_NOT_FOUND', 'ไม่พบรายการนี้')
    if (inquiry.status !== 'open') {
      throw new AppError(409, 'ALREADY_HANDLED',
        `รายการนี้ถูกจัดการแล้ว (status=${inquiry.status})`)
    }

    // 1) Push the reply to the tenant IN-PROCESS. This previously POSTed to the
    //    retired .NET bot (ROOM_MATCH_BOT_URL + X-Bot-Secret), which no longer
    //    exists — so every reply from this legacy page failed with a 500 and the
    //    customer never heard back. If the push fails we do NOT mark it replied,
    //    so admin can retry.
    if (!lineMessaging.isConfigured()) {
      throw new AppError(503, 'LINE_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่า Line Messaging API บนเซิร์ฟเวอร์')
    }
    try {
      await lineMessaging.pushMessage(inquiry.lineUserId, { type: 'text', text: req.body.reply })
    } catch (err) {
      throw new AppError(502, 'LINE_PUSH_FAILED',
        `ส่งข้อความไปยัง Line ไม่สำเร็จ: ${err?.message || 'unknown error'}`)
    }

    // 2) Mark replied
    const updated = await repo.markReplied(inquiry.id, req.body.reply)
    res.json(updated)
  }),
)

// ---------------------------------------------------------------------------
// POST /:id/resolve — admin closes without replying
// ---------------------------------------------------------------------------
botInquiries.post('/:id/resolve', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const inquiry = await repo.findById(req.params.id)
    if (!inquiry) throw new AppError(404, 'INQUIRY_NOT_FOUND', 'ไม่พบรายการนี้')
    if (inquiry.status === 'resolved') return res.json(inquiry)
    res.json(await repo.markResolved(inquiry.id))
  }),
)