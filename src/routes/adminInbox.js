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
import * as chatSessions from '../db/repositories/chatSessions.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { AppError }     from '../middleware/AppError.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { logger } from '../logger.js'
import * as lineMessaging from '../linebot/lineMessaging.service.js'
import { notifyAdminGroup } from '../linebot/adminAlert.service.js'

export const adminInbox = Router()

const idParam   = z.object({ id: z.coerce.number().int().positive() })
const replyBody = z.object({ reply: z.string().trim().min(1).max(2000) })

// User-facing notices pushed to Line when a live takeover starts / ends.
const NOTICE_TAKEOVER = 'แอดมินจะมาดูแลคุณเองนะคะ 🙋 พิมพ์ถามได้เลยค่ะ เดี๋ยวแอดมินตอบให้ค่ะ'
const NOTICE_RELEASE  = 'แอดมินส่งต่อให้บอทดูแลต่อแล้วนะคะ 🤖 ถามเรื่องห้องเช่าได้เลยค่ะ'

/** Stamp each inbox item with isLive = a human currently owns it. */
async function withLive(items) {
  const live = new Set(await chatSessions.listLive())
  return items.map((it) => ({ ...it, isLive: live.has(`${it.lineUserId}|${it.id}`) }))
}

/** Single-row version — used by action endpoints so the client keeps isLive
 *  fresh after a reply/takeover (otherwise the live-poll in the UI stops). */
async function withLiveOne(row) {
  if (!row) return row
  const live = new Set(await chatSessions.listLive())
  return { ...row, isLive: live.has(`${row.lineUserId}|${row.id}`) }
}

/** Best-effort push to a user's Line; throws AppError(502) so the admin can retry. */
async function pushToUser(lineUserId, text) {
  if (!lineMessaging.isConfigured()) return
  try {
    await lineMessaging.pushMessage(lineUserId, { type: 'text', text })
  } catch (err) {
    logger.error({ err, lineUserId }, 'inbox push to user failed')
    throw new AppError(502, 'LINE_PUSH_FAILED', 'ส่งข้อความไปยัง Line ไม่สำเร็จ กรุณาลองอีกครั้ง')
  }
}

adminInbox.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' && req.query.status !== 'all'
    ? req.query.status : null
  const limit  = Math.min(200, Math.max(1, Number(req.query.limit)  || 100))
  const offset = Math.max(0, Number(req.query.offset) || 0)
  const [items, summary] = await Promise.all([
    repo.list({ status, limit, offset }),
    repo.countByStatus(),
  ])
  res.json({ items: await withLive(items), summary, limit, offset })
}))

adminInbox.get('/summary', requireAdmin, asyncHandler(async (_req, res) => {
  res.json(await repo.countByStatus())
}))

adminInbox.get('/:id', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const row = await repo.findById(req.params.id)
    if (!row) throw new AppError(404, 'INQUIRY_NOT_FOUND', 'ไม่พบรายการนี้')
    res.json((await withLive([row]))[0])
  }),
)

adminInbox.post('/:id/reply', requireAdmin,
  validate({ params: idParam, body: replyBody }),
  asyncHandler(async (req, res) => {
    const item = await repo.findById(req.params.id)
    if (!item) throw new AppError(404, 'INQUIRY_NOT_FOUND', 'ไม่พบรายการนี้')

    const hs   = await chatSessions.getHandlerState(item.lineUserId)
    const live = hs.handler === 'human' && hs.activeTicketId === item.id

    // Push the reply to the user's Line directly. If Line isn't reachable we do
    // NOT record it — the admin sees the error and can retry (the client keeps
    // the typed text on failure).
    await pushToUser(item.lineUserId, req.body.reply)

    if (live) {
      // Live takeover: append the admin turn to the running thread and keep the
      // ticket open so the back-and-forth can continue.
      const updated = await repo.appendThread(item.id, {
        role: 'admin', text: req.body.reply, ts: new Date().toISOString(),
      })
      return res.json(await withLiveOne(updated))
    }

    // One-shot async reply (ticket not live): single admin_reply, status→replied.
    if (item.status !== 'open') {
      throw new AppError(409, 'ALREADY_HANDLED', `รายการนี้ถูกจัดการแล้ว (status=${item.status})`)
    }
    res.json(await withLiveOne(await repo.markReplied(item.id, { adminReply: req.body.reply })))
  }),
)

// ─── Live takeover ──────────────────────────────────────────────────────
//   POST /:id/takeover → mute the bot for this user, (re)open + link the ticket,
//                        tell the user a human is answering, alert the group.
//   POST /:id/release  → hand the user back to the bot, resolve the ticket,
//                        tell the user they're back with the bot.

adminInbox.post('/:id/takeover', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const item = await repo.findById(req.params.id)
    if (!item) throw new AppError(404, 'INQUIRY_NOT_FOUND', 'ไม่พบรายการนี้')

    await repo.reopen(item.id)
    await chatSessions.beginTakeover(item.lineUserId, {
      ticketId: item.id,
      adminId:  req.admin?.username || req.admin?.id || null,
    })
    await pushToUser(item.lineUserId, NOTICE_TAKEOVER)
    notifyAdminGroup(
      `🙋 [แอดมินรับเรื่อง]\n${item.summary || '(ไม่มีรายละเอียด)'}\n— ตอบได้ที่ /admin/inbox`,
    )
    res.json(await withLiveOne(await repo.findById(item.id)))
  }),
)

adminInbox.post('/:id/release', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const item = await repo.findById(req.params.id)
    if (!item) throw new AppError(404, 'INQUIRY_NOT_FOUND', 'ไม่พบรายการนี้')
    await chatSessions.endTakeover(item.lineUserId)
    const updated = await repo.markResolved(item.id)
    await pushToUser(item.lineUserId, NOTICE_RELEASE)
    res.json(await withLiveOne(updated))
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
