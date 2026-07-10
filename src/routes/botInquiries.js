// src/routes/botInquiries.js — Admin inbox of Line bot inquiries.
//
// Flow:
//
//   1. Line bot receives a message it can't answer (or an intent like
//      edit-description that always needs human action).
//   2. Bot POSTs here with X-Bot-Secret → row created with status=open.
//   3. Admin opens /admin/bot-inquiries, sees the list, picks one.
//   4. Admin types a reply → this route POSTs to the bot's
//      /api/admin/push to deliver the message to the tenant's Line,
//      then marks the row replied.
//   5. Admin can also resolve without replying (e.g. duplicate).
//
// Routes:
//   POST /api/admin/bot-inquiries              (bot)
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
import { requireBot }   from '../middleware/requireBot.js'
import { config }       from '../config.js'

export const botInquiries = Router()

const ALLOWED_TYPES = ['ask-about-room', 'edit-description', 'upload-photos', 'view-a-room']

const createBody = z.object({
  lineUserId:  z.string().trim().min(1).max(80),
  inquiryType: z.string().refine((v) => ALLOWED_TYPES.includes(v), {
    message: `inquiryType ต้องเป็นหนึ่งใน ${ALLOWED_TYPES.join(', ')}`,
  }),
  payload:     z.record(z.any()).optional().default({}),
})
const idParam = z.object({ id: z.coerce.number().int().positive() })

const replyBody = z.object({
  reply: z.string().trim().min(1).max(2000),
})

// ---------------------------------------------------------------------------
// POST — bot creates a new inquiry
// ---------------------------------------------------------------------------
botInquiries.post('/',
  requireBot,
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const created = await repo.create({
      lineUserId:  req.body.lineUserId,
      inquiryType: req.body.inquiryType,
      payload:     req.body.payload,
    })
    res.status(201).json(created)
  }),
)

// ---------------------------------------------------------------------------
// GET — admin lists inquiries
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
// POST /:id/reply — admin replies; we push to tenant via bot, then mark
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

    const botBaseUrl = config.ROOM_MATCH_BOT_URL
    const botSecret  = config.BOT_SHARED_SECRET
    if (!botBaseUrl || !botSecret) {
      throw new AppError(500, 'BOT_NOT_CONFIGURED',
        'ยังไม่ได้ตั้งค่า ROOM_MATCH_BOT_URL / BOT_SHARED_SECRET บนเซิร์ฟเวอร์')
    }

    // 1) Push the reply to the tenant via the bot. If this fails we don't
    //    mark the inquiry replied — admin can retry.
    const pushRes = await fetch(`${botBaseUrl}/api/admin/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': botSecret,
      },
      body: JSON.stringify({
        lineUserId: inquiry.lineUserId,
        messages: [
          { type: 'text', text: req.body.reply },
        ],
      }),
    })
    if (!pushRes.ok) {
      const err = await pushRes.text().catch(() => '')
      throw new AppError(502, 'BOT_PUSH_FAILED',
        `ส่งข้อความไปยัง Line ไม่สำเร็จ: ${err || pushRes.status}`)
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