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
import { notifyAdminGroup } from './adminAlert.service.js'

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
    const replyToken = ev?.replyToken ?? null
    const eventType  = ev?.type ?? 'unknown'
    const messageType = ev?.message?.type ?? null

    await appendWebhook({ lineUserId, replyToken, eventType, event: ev })
    logger.info({ lineUserId, eventType, messageType }, 'line webhook received')

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
        await handle(lineUserId, ev?.message?.text ?? '', replyToken)
      } else if (eventType === 'message' && messageType === 'image') {
        await handleImage(lineUserId, ev?.message?.id, replyToken)
      } else if (eventType === 'postback') {
        await handlePostback(lineUserId, ev?.postback?.data)
      } else if (eventType === 'follow' && lineUserId) {
        // New friend added the bot — send a welcome + the quick-reply menu so
        // desktop users (no Rich Menu) immediately see how to get started.
        await push(lineUserId, { ...welcome(), quickReply: menuQuickReply() })
      }
      // 'unfollow','leave', etc. → no-op (audit-logged above)
    } catch (err) {
      logger.error({ err, lineUserId, eventType, messageType }, 'webhook dispatch failed')
    }
  }
}

/**
 * Deterministic postback dispatcher (no LLM). Data is a query string set by the
 * Flex button, e.g. `action=book&slotId=5`. Today only `book` is supported.
 */
export async function handlePostback(lineUserId, dataStr) {
  if (!lineUserId) return
  const params = new URLSearchParams(typeof dataStr === 'string' ? dataStr : '')
  const action = params.get('action')
  logger.info({ lineUserId, action, data: dataStr }, 'postback received')

  if (action === 'book') {
    const slotId = Number(params.get('slotId'))
    if (Number.isInteger(slotId)) await bookSlot(lineUserId, slotId)
    else await push(lineUserId, 'ขออภัยค่ะ ไม่สามารถจองได้ (ข้อมูลไม่ถูกต้อง)')
  }
  // Unknown actions are no-ops (logged above).
}

/**
 * Book a viewing slot on behalf of the Line user: validate the slot is still
 * open + future, upsert the tenant, create a 'requested' viewing, atomically
 * mark the slot booked, and push a confirmation. All best-effort — a failure
 * pushes a polite message and the webhook still returns 200.
 */
async function bookSlot(lineUserId, slotId) {
  const slot = await viewingSlots.findById(slotId)
  const now = Date.now()
  if (!slot || slot.status !== 'open' || new Date(slot.startsAt).getTime() < now) {
    await push(lineUserId, 'ขออภัยค่ะ เวลาที่เลือกไม่สามารถจองได้แล้ว รบกวนเลือกช่วงอื่นนะคะ')
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
    await push(lineUserId, 'ขออภัยค่ะ จองไม่สำเร็จ กรุณาลองอีกครั้งนะคะ')
    return
  }

  // Atomically claim the slot; if two users raced, the loser's viewing is voided.
  const booked = await viewingSlots.markBooked(slot.id, viewing.id)
  if (!booked) {
    await push(lineUserId, 'ขออภัยค่ะ เวลานี้ถูกจองไปแล้ว รบกวนเลือกช่วงอื่นนะคะ')
    return
  }

  const room = await findRoomById(slot.roomId)
  await push(lineUserId, viewingConfirmation({
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
