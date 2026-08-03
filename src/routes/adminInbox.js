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
import * as lineLogs from '../db/repositories/lineLogs.repo.js'
import * as roomInterest from '../db/repositories/roomInterest.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { AppError }     from '../middleware/AppError.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { logger } from '../logger.js'
import * as lineMessaging from '../linebot/lineMessaging.service.js'
import { notifyAdminGroup } from '../linebot/adminAlert.service.js'
import { reset as resetBotRateLimit } from '../linebot/botRateLimit.service.js'

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

/**
 * GET /conversations — EVERY user who has written in, not just escalations.
 * Ones waiting on a human float to the top. See repo.listConversations for why
 * this reads the webhook log instead of chat_sessions.
 */
adminInbox.get('/conversations', requireAdmin, asyncHandler(async (req, res) => {
  const filter = ['all', 'needs_admin', 'bot'].includes(req.query.filter) ? req.query.filter : 'all'
  const limit  = Math.min(300, Math.max(1, Number(req.query.limit) || 100))
  const [items, summary] = await Promise.all([
    repo.listConversations({ filter, limit }),
    repo.countConversations(),
  ])
  const live = new Set(await chatSessions.listLive())
  res.json({
    items: items.map((c) => ({
      ...c,
      isLive: c.ticketId ? live.has(`${c.lineUserId}|${c.ticketId}`) : false,
    })),
    summary,
  })
}))

/**
 * GET /conversations/:lineUserId — the FULL transcript for one user.
 *
 * Rebuilt from the inbound + outbound LINE logs, not from chat_sessions.history:
 * that history is the LLM's context window, so it omits stickers, the admin's own
 * replies and the takeover/release notices, and it is wiped after 24h. Admins
 * comparing this panel against LINE were seeing entire messages missing.
 */
adminInbox.get('/conversations/:lineUserId', requireAdmin, asyncHandler(async (req, res) => {
  const lineUserId = String(req.params.lineUserId)
  const [transcript, ticket, room] = await Promise.all([
    lineLogs.loadTranscript(lineUserId).catch(() => []),
    repo.findOpenByLineUser(lineUserId).catch(() => null),
    // Which room they tapped "สอบถามห้องนี้" on, if any — so admin opens the
    // chat already knowing what it's about instead of having to ask.
    roomInterest.latestForUser(lineUserId).catch(() => null),
  ])
  res.json({
    lineUserId,
    transcript: transcript || [],
    ticket: ticket ? await withLiveOne(ticket) : null,
    room,
  })
}))

/**
 * POST /conversations/:lineUserId/claim — start handling someone who never
 * escalated. Creates a ticket if needed, then runs the normal takeover.
 */
adminInbox.post('/conversations/:lineUserId/claim', requireAdmin, asyncHandler(async (req, res) => {
  const lineUserId = String(req.params.lineUserId)
  const ticket = await repo.findOrCreateOpenTicket(lineUserId)
  const admin  = req.admin?.displayName || req.admin?.username || req.admin?.id || null
  await chatSessions.beginTakeover(lineUserId, { ticketId: ticket.id, adminId: admin })
  resetBotRateLimit(lineUserId)
  await pushToUser(lineUserId, NOTICE_TAKEOVER)
  notifyAdminGroup(`🙋 @${admin || 'แอดมิน'} เปิดคุยกับลูกค้าเอง`)
  res.json(await withLiveOne(await repo.findById(ticket.id)))
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
      // First admin to engage claims the chat → record who answered and announce
      // once in the group (so the team can see who picked it up).
      const admin = req.admin?.displayName || req.admin?.username || null
      if (admin && !hs.takenOverBy) {
        await chatSessions.claim(item.lineUserId, admin)
        notifyAdminGroup(`🙋 @${admin} รับเรื่อง "${item.summary || ''}" แล้ว`)
      }
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

    const admin = req.admin?.displayName || req.admin?.username || req.admin?.id || null
    await repo.reopen(item.id)
    await chatSessions.beginTakeover(item.lineUserId, { ticketId: item.id, adminId: admin })
    // An admin has judged this person a real customer — drop any anti-abuse
    // counter so the bot is immediately responsive again when handed back.
    resetBotRateLimit(item.lineUserId)
    await pushToUser(item.lineUserId, NOTICE_TAKEOVER)
    // Announce WHO accepted, so the team can track which admin is handling it.
    notifyAdminGroup(`🙋 @${admin || 'แอดมิน'} รับเรื่อง "${item.summary || ''}" แล้ว`)
    res.json(await withLiveOne(await repo.findById(item.id)))
  }),
)

adminInbox.post('/:id/release', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const item = await repo.findById(req.params.id)
    if (!item) throw new AppError(404, 'INQUIRY_NOT_FOUND', 'ไม่พบรายการนี้')
    await chatSessions.endTakeover(item.lineUserId)
    // Clear the flood counter too. Without this, closing a ticket inside the
    // rate-limit window left the bot ignoring the customer for the remainder,
    // with no message explaining why.
    resetBotRateLimit(item.lineUserId)
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
