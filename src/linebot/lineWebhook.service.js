// src/linebot/lineWebhook.service.js — Verify Line webhook signatures and
// route inbound events to handlers (text / image / postback).
//
// The Line webhook sends `X-Line-Signature: <base64 HMAC-SHA256>` computed
// over the *raw* request body using LINE_CHANNEL_SECRET. This is the ONLY way
// to confirm a webhook came from Line. The C# bot never did this check.
//
// Dispatch:
//   message/text   → chatAgent.handle
//   message/image  → chatAgent.handleImage
//   postback       → handlePostback (deterministic actions, e.g. book a slot)
//   follow/unfollow/… → no-op (audit-logged)

import crypto from 'node:crypto'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { appendWebhook } from '../db/repositories/lineLogs.repo.js'
import * as lineMessaging from './lineMessaging.service.js'
import { findById as findRoomById } from '../db/repositories/rooms.repo.js'
import * as viewingSlots from '../db/repositories/viewingSlots.repo.js'
import { createForTenant } from '../db/repositories/viewings.repo.js'
import { findByLineId as findTenantByLineId, createFromBot as createTenantFromBot } from '../db/repositories/tenants.repo.js'
import { viewingConfirmation, welcome, menuQuickReply } from './flexMessages.js'
import { notifyAdminGroup, alertAdmins } from './adminAlert.service.js'
import * as chatSessions from '../db/repositories/chatSessions.repo.js'
import * as adminQueue from '../db/repositories/adminQueue.repo.js'
import { enqueue } from './dispatchQueue.service.js'
import { consume as consumeRate } from './botRateLimit.service.js'
import { parseRoomRef, stripRoomRef } from '../services/roomRef.js'
import * as roomInterest from '../db/repositories/roomInterest.repo.js'

const SIGNATURE_HEADER = 'x-line-signature'

export function verifySignature(rawBody, headerValue) {
  const secret = config.LINE_CHANNEL_SECRET
  if (!secret) return false
  if (!headerValue || typeof headerValue !== 'string') return false

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64')

  const a = Buffer.from(expected)
  const b = Buffer.from(headerValue)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function isConfigured() {
  return Boolean(config.LINE_CHANNEL_ACCESS_TOKEN && config.LINE_CHANNEL_SECRET)
}

/**
 * Handle a parsed Line webhook payload. Fire-and-forget — never throws.
 * One bad event never poisons the batch; the webhook still returns 200 (Line
 * retries non-2xx and would flood).
 */
export async function handleEvent(payload) {
  if (!payload || !Array.isArray(payload.events)) return
  const { handle, handleImage } = await import('./chatAgent.service.js')
  for (const ev of payload.events) {
    const lineUserId = ev?.source?.userId ?? null
    const groupId    = ev?.source?.groupId ?? ev?.source?.roomId ?? null
    const key        = lineUserId || groupId || '_no_user'

    // Serialize per user/group (in arrival order), run different users
    // concurrently up to a global cap. The route has ALREADY acked Line by the
    // time these jobs run. enqueue swallows errors so one bad event can't break
    // the chain for that user.
    enqueue(key, () => processEvent(ev, { handle, handleImage }), 'line-event')
  }
}

/**
 * Process one webhook event: audit-log it, then dispatch (group handling /
 * chatAgent / image / postback / follow / live-agent). Runs inside the dispatch
 * queue, so it is serialized per user. Never throws to the queue (caught here).
 */
async function processEvent(ev, { handle, handleImage }) {
  const lineUserId   = ev?.source?.userId ?? null
  const replyToken   = ev?.replyToken ?? null
  const eventType    = ev?.type ?? 'unknown'
  const messageType  = ev?.message?.type ?? null

  await appendWebhook({ lineUserId, replyToken, eventType, event: ev })
  logger.info({ lineUserId, eventType, messageType }, 'line webhook received')

  // Show "อ่านแล้ว" under the user's message straight away. This is a separate
  // LINE API from replying — sending a reply does NOT produce a read receipt —
  // so it has to be fired explicitly, and early, while the person is still
  // looking at the chat waiting for an answer. Fire-and-forget: it's cosmetic.
  const markToken = ev?.message?.markAsReadToken ?? ev?.markAsReadToken
  if (markToken) lineMessaging.markAsRead(markToken).catch(() => {})

  try {
    const sourceType = ev?.source?.type ?? 'user'
    const groupId = ev?.source?.groupId ?? ev?.source?.roomId ?? null

    // In group/room chats the bot is PASSIVE: it only pushes alerts here, it
    // never replies to chatter or runs the LLM. Surface the group id on join
    // (and on a "group id" command) so admins can wire up LINE_ADMIN_GROUP_ID.
    if (sourceType === 'group' || sourceType === 'room') {
      if (eventType === 'join' && groupId) {
        await push(groupId, { type: 'text', text:
          'สวัสดีค่ะ น้องห้องเข้าร่วมกลุ่มแล้ว 🙌\n' +
          `Group ID ของกลุ่มนี้:\n${groupId}\n\n` +
          'คัดลอกเลขนี้ไปใส่ LINE_ADMIN_GROUP_ID เพื่อให้แจ้งเตือนเข้ากลุ่มนี้ได้เลยค่ะ' })
      } else if (eventType === 'message' && messageType === 'text' && groupId) {
        const t = (ev?.message?.text ?? '').trim().toLowerCase()
        if (t === 'group id' || t === 'id' || t === 'รหัสกลุ่ม') {
          await push(groupId, { type: 'text', text: `Group ID: ${groupId}` })
        }
      }
    } else if (eventType === 'message' && messageType === 'text') {
      ensureKnownUser(lineUserId)   // fire-and-forget: never delay the reply
      // A message sent from a room page carries a signed tag naming that room.
      // Record it and strip it, so admin and the bot both know what "ห้องนี้"
      // means and the customer never sees the plumbing in their own chat.
      const raw  = ev?.message?.text ?? ''
      const text = await noteRoomInterest(lineUserId, raw)
      if (await routeToLiveAgent(lineUserId, { ...ev, message: { ...ev.message, text } })) return
      if (await handOffIfFlooding(lineUserId, text, replyToken)) return
      await handle(lineUserId, text, replyToken)
    } else if (eventType === 'message' && messageType === 'image') {
      ensureKnownUser(lineUserId)
      if (await routeToLiveAgent(lineUserId, ev)) return
      if (await handOffIfFlooding(lineUserId, '📷 (รูปภาพ)', replyToken)) return
      await handleImage(lineUserId, ev?.message?.id, replyToken)
    } else if (eventType === 'postback') {
      ensureKnownUser(lineUserId)
      if (await routeToLiveAgent(lineUserId, ev)) return
      await handlePostback(lineUserId, ev?.postback?.data, replyToken)
    } else if (eventType === 'follow' && lineUserId) {
      // New friend added the bot — make sure we know who they are.
      try {
        await ensureKnownUser(lineUserId)
      } catch (err) {
        logger.error({ err, lineUserId }, 'follow: failed to create tenant row')
      }
      // Send welcome + quick-reply menu (rides the FREE reply path).
      await lineMessaging.replyOrPush(lineUserId, replyToken, { ...welcome(), quickReply: menuQuickReply() })
    }
    // 'unfollow','leave', etc. → no-op (audit-logged above)
  } catch (err) {
    logger.error({ err, lineUserId, eventType, messageType }, 'webhook dispatch failed')
  }
}

/**
 * If the message carries a room tag, record the interest and return the message
 * without it. Returns the original text unchanged when there is no tag, or when
 * recording fails — knowing the room is a bonus, never a precondition for
 * answering someone.
 */
async function noteRoomInterest(lineUserId, text) {
  const roomId = parseRoomRef(text)
  if (!roomId) return text
  try {
    await roomInterest.record({ lineUserId, roomId, source: 'web-cta' })
    logger.info({ lineUserId, roomId }, 'room interest recorded from web CTA')
  } catch (err) {
    // A bad room id (deleted room) trips the FK — not worth failing the turn.
    logger.warn({ err: err.message, lineUserId, roomId }, 'room interest not recorded')
  }
  const stripped = stripRoomRef(text)
  // An empty result means the tag WAS the whole message (the customer sent the
  // pre-filled text untouched); give the bot something to answer.
  return stripped || 'สนใจห้องนี้ค่ะ'
}

// A tenant stub is named "Line user <first 8 of id>" until the real LINE display
// name lands. Anything matching this is still a placeholder worth replacing.
const PLACEHOLDER_NAME = /^Line user /i

/**
 * Make sure we have a row (and a real display name) for this LINE user.
 *
 * WHY: the admin inbox resolves a name from tenants/landlords by line_id. Rows
 * were only ever created on the `follow` event, so anyone who added the bot
 * before that code existed — or whose follow event we missed — stayed unknown
 * and showed up in the inbox as a raw "Ufb79e53…" id.
 *
 * Called on every 1:1 event, so it must stay cheap:
 *   • one indexed lookup; if a real name is already stored, it stops there
 *   • the LINE profile call only happens for a brand-new or still-placeholder
 *     row, and getProfile is itself cached for 5 minutes
 *
 * Fire-and-forget at the call sites — never let this delay a customer's reply.
 * Landlord-only users are left alone: they already have a landlords row, and
 * the inbox falls back to that name.
 */
async function ensureKnownUser(lineUserId) {
  if (!lineUserId) return
  try {
    let tenant = await findTenantByLineId(lineUserId)
    if (tenant && !PLACEHOLDER_NAME.test(tenant.full_name || '')) return  // already named

    // Don't shadow a landlord who has a proper name and no tenant row.
    if (!tenant) {
      const { findByLineId: findLandlordByLineId } = await import('../db/repositories/landlords.repo.js')
      const landlord = await findLandlordByLineId(lineUserId).catch(() => null)
      if (landlord && !PLACEHOLDER_NAME.test(landlord.fullName || landlord.full_name || '')) return
      tenant = await createTenantFromBot(lineUserId)
    }

    if (!lineMessaging.isConfigured()) return
    const profile = await lineMessaging.getProfile(lineUserId).catch(() => null)
    if (!profile?.displayName) return
    const { refreshFromLine } = await import('../db/repositories/tenants.repo.js')
    await refreshFromLine(tenant.id, {
      displayName: profile.displayName,
      pictureUrl:  profile.pictureUrl,
    })
    logger.info({ lineUserId, name: profile.displayName }, 'captured line display name')
  } catch (err) {
    logger.error({ err, lineUserId }, 'ensureKnownUser failed')
  }
}

/**
 * Budget guard for LLM-backed turns — a HAND-OFF, not a wall.
 *
 * The cap exists to stop an automated flood from running up an unbounded Gemini
 * bill and monopolising the concurrency pool. It must never punish a customer
 * for asking a lot: real traffic peaks around 16 messages / 5 min, and the cap
 * sits far above that (a human can't outpace it, because each turn waits on the
 * bot's reply — a script blows through it in seconds).
 *
 * When someone does exceed it we escalate to a human instead of going silent:
 * one admin_queue ticket is opened, the customer is told an admin is taking
 * over, and further messages in the window are dropped quietly so a flood can't
 * spam the inbox. Once the window rolls over the bot resumes on its own.
 *
 * MUST be called AFTER routeToLiveAgent: a customer already talking to a human
 * costs no LLM at all, and dropping those messages would silently break the
 * live chat.
 *
 * @returns {Promise<boolean>} true → caller must skip the LLM
 */
async function handOffIfFlooding(lineUserId, userText, replyToken) {
  if (!lineUserId) return false
  const { allowed, warn } = consumeRate(lineUserId)
  if (allowed) return false

  // Only the FIRST overflow in the window notifies anyone.
  if (warn) {
    try {
      await alertAdmins({
        lineUserId,
        reason:  'system-error',
        summary: 'ลูกค้าส่งข้อความถี่ผิดปกติ — บอทหยุดตอบชั่วคราว รอแอดมินดูแลต่อ',
        originalPayload: { message: String(userText || '').slice(0, 500) },
      })
    } catch (err) {
      logger.error({ err, lineUserId }, 'flood hand-off: alertAdmins failed')
    }
    await lineMessaging.replyOrPush(lineUserId, replyToken,
      'ขอส่งต่อให้แอดมินดูแลต่อนะคะ 🙋 เดี๋ยวแอดมินตอบให้ค่ะ')
      .catch(() => {})
  }
  return true
}

/**
 * If a human admin has taken over this user's chat, route the inbound event to
 * the live admin_queue ticket's `thread` (and ping the admin group) instead of
 * the LLM. Returns true when handled (caller skips Gemini), false otherwise.
 * Never throws — a DB hiccup here falls through to the normal AI path.
 */
async function routeToLiveAgent(lineUserId, ev) {
  if (!lineUserId) return false
  let state
  try {
    state = await chatSessions.getHandlerState(lineUserId)
  } catch (err) {
    logger.error({ err, lineUserId }, 'live-agent state read failed')
    return false
  }
  if (!state || state.handler !== 'human' || !state.activeTicketId) return false

  // Describe the inbound event as a transcript line.
  let label
  if (ev?.type === 'postback') {
    label = `🔘 (${ev?.postback?.data || 'action'})`
  } else if (ev?.message?.type === 'image') {
    label = '📷 ส่งรูปภาพมา'
  } else {
    label = (ev?.message?.text ?? '(ข้อความ)').slice(0, 1000)
  }

  try {
    await adminQueue.appendThread(state.activeTicketId, {
      role: 'user',
      text:  label,
      ts:    new Date().toISOString(),
    })
  } catch (err) {
    logger.error({ err, lineUserId, ticketId: state.activeTicketId }, 'live-agent thread append failed')
  }
  // Note: we intentionally do NOT push the user's message to the admin group —
  // the conversation lives in the inbox thread (polled by the UI). The group only
  // gets the escalation ping + the one-time "@admin รับเรื่องแล้ว" on accept.
  return true
}

/**
 * Deterministic postback dispatcher. Data is a query string set by the Flex
 * button, e.g. `action=book&slotId=5`. Supported actions: `book` (deterministic
 * slot booking), and `viewing`/`details` (room-card taps that re-enter the agent
 * with the internal roomId, so the user sees the room number but lookups use id).
 */
export async function handlePostback(lineUserId, dataStr, replyToken = null) {
  if (!lineUserId) return
  const params = new URLSearchParams(typeof dataStr === 'string' ? dataStr : '')
  const action = params.get('action')
  logger.info({ lineUserId, action, data: dataStr }, 'postback received')

  if (action === 'book') {
    const slotId = Number(params.get('slotId'))
    if (Number.isInteger(slotId)) await bookSlot(lineUserId, slotId, replyToken)
    else await lineMessaging.replyOrPush(lineUserId, replyToken, 'ขออภัยค่ะ ไม่สามารถจองได้ (ข้อมูลไม่ถูกต้อง)')
  } else if (action === 'viewing' || action === 'details') {
    // Room cards send these when the user taps อยากนัดชม / ดูรายละเอียด. The
    // button shows the room NUMBER (displayText) while the internal id rides in
    // `data`, so we re-enter the normal agent path with an id-bearing phrase —
    // scheduleViewing / getRoomDetails then resolve the room reliably by id and
    // the model replies in the user's language, exactly as a typed message would.
    const roomId = Number(params.get('roomId'))
    if (Number.isInteger(roomId)) {
      const { handle } = await import('./chatAgent.service.js')
      const phrase = action === 'viewing' ? `อยากนัดชมห้อง ${roomId}` : `ดูห้อง ${roomId}`
      await handle(lineUserId, phrase, replyToken)
    } else {
      await lineMessaging.replyOrPush(lineUserId, replyToken, 'ขออภัยค่ะ ไม่พบข้อมูลห้อง (ข้อมูลไม่ถูกต้อง)')
    }
  }
  // Unknown actions are no-ops (logged above).
}

/**
 * Book a viewing slot on behalf of the Line user: validate the slot is still
 * open + future, upsert the tenant, create a 'requested' viewing, atomically
 * mark the slot booked, and send a confirmation. The confirmation rides the
 * FREE reply path (postback events carry a reply token). The admin-group alert
 * is a metered push (no token) — it's admin-side awareness. All best-effort.
 */
async function bookSlot(lineUserId, slotId, replyToken = null) {
  const slot = await viewingSlots.findById(slotId)
  const now = Date.now()
  if (!slot || slot.status !== 'open' || new Date(slot.startsAt).getTime() < now) {
    await lineMessaging.replyOrPush(lineUserId, replyToken, 'ขออภัยค่ะ เวลาที่เลือกไม่สามารถจองได้แล้ว รบกวนเลือกช่วงอื่นนะคะ')
    return
  }

  let tenant = await findTenantByLineId(lineUserId)
  if (!tenant) tenant = await createTenantFromBot(lineUserId)

  const viewing = await createForTenant({
    roomId:           slot.roomId,
    tenantId:         tenant.id,
    tenantLineUserId: lineUserId,
    scheduledFor:     slot.startsAt,
    note:             null,
  })
  if (!viewing) {
    await lineMessaging.replyOrPush(lineUserId, replyToken, 'ขออภัยค่ะ จองไม่สำเร็จ กรุณาลองอีกครั้งนะคะ')
    return
  }

  // Atomically claim the slot; if two users raced, the loser's viewing is voided.
  const booked = await viewingSlots.markBooked(slot.id, viewing.id)
  if (!booked) {
    await lineMessaging.replyOrPush(lineUserId, replyToken, 'ขออภัยค่ะ เวลานี้ถูกจองไปแล้ว รบกวนเลือกช่วงอื่นนะคะ')
    return
  }

  const room = await findRoomById(slot.roomId)
  await lineMessaging.replyOrPush(lineUserId, replyToken, viewingConfirmation({
    roomTitle:    room?.title,
    scheduledFor: bangkokDisplay(slot.startsAt),
    viewingId:    viewing.id,
  }))
  logger.info({ lineUserId, roomId: slot.roomId, viewingId: viewing.id, slotId }, 'slot booked via postback')
  notifyAdminGroup(`📅 [จองนัดชม]\nลูกค้าจองนัดชมห้อง "${room?.title ?? ''}" เวลา ${bangkokDisplay(slot.startsAt)}\nสถานะ: รอแอดมินยืนยัน\n— ยืนยัน/ปฏิเสธได้ที่ /admin/viewings`)
}

function bangkokDisplay(iso) {
  try {
    return new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'long', timeStyle: 'short' })
  } catch {
    return iso
  }
}

/** Push helper — swallows Line-side errors so a bad push never crashes the webhook. */
async function push(lineUserId, message) {
  try {
    if (!lineMessaging.isConfigured()) return
    const msg = typeof message === 'string' ? { type: 'text', text: message } : message
    await lineMessaging.pushMessage(lineUserId, msg)
  } catch (err) {
    logger.error({ err, lineUserId }, 'line postback push failed')
  }
}
