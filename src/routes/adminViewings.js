// src/routes/adminViewings.js — Admin confirmation of tenant viewing requests.
//
// A tenant books a viewing slot through the Line chatbot (a postback) → a
// viewings row is created at status='requested'. That booking is only
// provisional until an admin acts on it here:
//   confirm → status='confirmed' + a Line push to the tenant
//   decline → status='declined', the slot reopens for someone else, and the
//             tenant is pushed a "please pick another time" message
//
//   GET   /api/admin/viewings             (admin) → list (?status=requested|confirmed|…|all)
//   POST  /api/admin/viewings             (admin) → book an appointment for a
//                                                    tenant directly (confirmed)
//   POST  /api/admin/viewings/:id/confirm (admin)
//   POST  /api/admin/viewings/:id/decline (admin)  — reject a pending request
//   POST  /api/admin/viewings/:id/cancel  (admin)  — cancel a booking the tenant
//                                                    can no longer make
//
// (The older landlord confirm/decline path lives on PATCH /api/viewings/:id.
// In the middleman model the ADMIN is the one who confirms tenant bookings, so
// this admin-gated route is the canonical path; the landlord route is kept for
// the landlord portal.)

import { Router } from 'express'
import { z } from 'zod'
import * as viewings from '../db/repositories/viewings.repo.js'
import * as viewingSlots from '../db/repositories/viewingSlots.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { AppError }     from '../middleware/AppError.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { logger } from '../logger.js'
import * as lineMessaging from '../linebot/lineMessaging.service.js'
import { notifyAdminGroup } from '../linebot/adminAlert.service.js'

export const adminViewings = Router()

const idParam = z.object({ id: z.coerce.number().int().positive() })

function bangkok(iso) {
  try {
    return new Date(iso).toLocaleString('th-TH', {
      timeZone: 'Asia/Bangkok', dateStyle: 'long', timeStyle: 'short',
    })
  } catch {
    return iso
  }
}

// Sales hours: Monday–Saturday, 09:00–18:00 Bangkok time. A viewing may START
// from 09:00 up to (but not including) 18:00. Evaluated in ICT so it's correct
// regardless of the server's own timezone.
function withinSalesHours(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return false
  const dow  = d.toLocaleString('en-US', { timeZone: 'Asia/Bangkok', weekday: 'short' })
  const hour = Number(d.toLocaleString('en-US', { timeZone: 'Asia/Bangkok', hour: '2-digit', hour12: false }))
  return dow !== 'Sun' && hour >= 9 && hour < 18
}

// Shape a viewing row (SELECT_BASE) for the admin list. Admin may see tenant
// contact (they need it to arrange the viewing), but we map an explicit
// whitelist rather than dumping the raw joined row.
function mapRow(v) {
  if (!v) return null
  return {
    id:           v.id,
    roomId:       v.room_id,
    status:       v.status,
    scheduledFor: v.scheduled_for,
    requestedAt:  v.requested_at ?? v.created_at,
    room: {
      title: v.room_title,
      rent:  v.room_rent,
      zone:  v.zone_name_th,
      image: v.room_image,
    },
    tenant: {
      name:   v.tenant_name,
      phone:  v.tenant_phone,
      email:  v.tenant_email,
      lineId: v.tenant_line_user_id || v.tenant_line_id,
    },
  }
}

adminViewings.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const q = typeof req.query.status === 'string' ? req.query.status : 'requested'
  const status = q === 'all' ? null : q
  const rows = await viewings.findForAdmin({ status })
  res.json(rows.map(mapRow))
}))

// POST / — admin books an appointment directly for a tenant who asked them to
// arrange it. Created as 'confirmed' and the tenant is pushed a LINE confirmation.
// Time comes from the admin: the self-service slot flow is gone, so there is no
// slot to click. Kept accepting slotId would be accepting a value nothing can
// produce.
// (was: EITHER a clicked open slot (slotId — preferred, and booked
// atomically so a tenant can't grab it via the bot at the same moment) OR a
// free-typed scheduledFor (for rooms that have no open slots).
const createBody = z.object({
  tenantId:     z.coerce.number().int().positive(),
  roomId:       z.coerce.number().int().positive(),
  slotId:       z.coerce.number().int().positive().optional(),
  scheduledFor: z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: 'รูปแบบวันเวลาไม่ถูกต้อง' }).optional(),
  note:         z.string().trim().max(500).optional().or(z.literal('')),
}).refine((b) => b.slotId != null || b.scheduledFor != null, {
  message: 'ต้องเลือกช่วงเวลา หรือระบุวันเวลาเอง',
})

adminViewings.post('/', requireAdmin, validate({ body: createBody }), asyncHandler(async (req, res) => {
  const { tenantId, roomId, slotId } = req.body
  const note = req.body.note || null

  // A clicked slot must still be open, belong to this room, and be in the future.
  let scheduledFor = req.body.scheduledFor
  let slot = null
  if (slotId != null) {
    slot = await viewingSlots.findById(slotId)
    if (!slot || slot.status !== 'open' || slot.roomId !== roomId || new Date(slot.startsAt).getTime() < Date.now()) {
      throw new AppError(409, 'SLOT_UNAVAILABLE', 'ช่วงเวลานี้จองไม่ได้แล้ว รบกวนเลือกช่วงอื่นนะคะ')
    }
    scheduledFor = slot.startsAt
  } else if (!withinSalesHours(scheduledFor)) {
    // Free-typed time must fall inside sales hours (Mon–Sat 09:00–18:00 ICT).
    // Slot times skip this — admin created them, they're already within hours.
    throw new AppError(400, 'OUTSIDE_HOURS', 'นัดชมได้เฉพาะเวลาทำการ จันทร์-เสาร์ 9:00-18:00 น.')
  }

  const v = await viewings.createForAdmin({ tenantId, roomId, scheduledFor, note, status: 'confirmed' })
  if (!v) throw new AppError(400, 'VIEWING_CREATE_FAILED', 'สร้างนัดชมไม่สำเร็จ')

  // Claim the slot atomically; if it was booked between our check and here, void
  // the viewing we just made and ask the admin to pick another time.
  if (slot) {
    const booked = await viewingSlots.markBooked(slot.id, v.id)
    if (!booked) {
      await viewings.updateStatus(v.id, { status: 'cancelled' }).catch(() => {})
      throw new AppError(409, 'SLOT_TAKEN', 'ช่วงเวลานี้เพิ่งถูกจองไป รบกวนเลือกช่วงอื่นนะคะ')
    }
  }

  const adminTag = `@${req.admin?.displayName || req.admin?.username || 'แอดมิน'}`
  pushToTenant(v, `✅ แอดมินนัดชมห้อง "${v.room_title}" ให้คุณแล้วค่ะ เจอกัน ${bangkok(v.scheduled_for)} นะคะ`)
  notifyAdminGroup(`🗓 [แอดมินสร้างนัดชม]\n"${v.room_title}" — ${bangkok(v.scheduled_for)}\nสร้างโดย: ${adminTag}`)
  logger.info({ viewingId: v.id, admin: req.admin?.displayName || req.admin?.username }, 'viewing created by admin')
  res.status(201).json(mapRow(v))
}))

adminViewings.post('/:id/confirm', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const v = await viewings.updateStatus(req.params.id, { status: 'confirmed' })
    if (!v) throw new AppError(404, 'VIEWING_NOT_FOUND', 'ไม่พบคำขอนัดชมนี้')
    const adminTag = `@${req.admin?.displayName || req.admin?.username || 'แอดมิน'}`
    pushToTenant(v, `✅ ยืนยันนัดชมห้อง "${v.room_title}" แล้วค่ะ เจอกัน ${bangkok(v.scheduled_for)} นะคะ`)
    notifyAdminGroup(`✅ [ยืนยันนัดชม]\n"${v.room_title}" — ${bangkok(v.scheduled_for)}\nยืนยันโดย: ${adminTag}`)
    logger.info({ viewingId: v.id, admin: req.admin?.displayName || req.admin?.username }, 'viewing confirmed by admin')
    res.json(mapRow(v))
  }),
)

adminViewings.post('/:id/decline', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const v = await viewings.updateStatus(req.params.id, { status: 'declined' })
    if (!v) throw new AppError(404, 'VIEWING_NOT_FOUND', 'ไม่พบคำขอนัดชมนี้้')
    const adminTag = `@${req.admin?.displayName || req.admin?.username || 'แอดมิน'}`
    // Free the slot so another tenant can book it; safe no-op if already gone.
    await viewingSlots.reopenByViewing(req.params.id)
    pushToTenant(v, `ขออภัยค่ะ คุณแอดมินต้องเลื่อนนัดชมห้อง "${v.room_title}" รบกวนเลือกเวลาใหม่ได้เลยนะคะ 🙏`)
    notifyAdminGroup(`❌ [เลื่อนนัดชม]\n"${v.room_title}" — ${bangkok(v.scheduled_for)}\nเลื่อนโดย: ${adminTag}`)
    logger.info({ viewingId: v.id, admin: req.admin?.displayName || req.admin?.username }, 'viewing declined by admin')
    res.json(mapRow(v))
  }),
)

adminViewings.post('/:id/cancel', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const v = await viewings.updateStatus(req.params.id, { status: 'cancelled' })
    if (!v) throw new AppError(404, 'VIEWING_NOT_FOUND', 'ไม่พบรายการนัดชมนี้')
    const adminTag = `@${req.admin?.displayName || req.admin?.username || 'แอดมิน'}`
    // Free the slot so it can be re-booked (safe no-op if there was none).
    await viewingSlots.reopenByViewing(req.params.id)
    pushToTenant(v, `แจ้งยกเลิกนัดชมห้อง "${v.room_title}" (${bangkok(v.scheduled_for)}) ค่ะ 🙏 หากต้องการนัดใหม่ ทักหาแอดมินได้เลยนะคะ`)
    notifyAdminGroup(`🚫 [ยกเลิกนัดชม]\n"${v.room_title}" — ${bangkok(v.scheduled_for)}\nยกเลิกโดย: ${adminTag}`)
    logger.info({ viewingId: v.id, admin: req.admin?.displayName || req.admin?.username }, 'viewing cancelled by admin')
    res.json(mapRow(v))
  }),
)

/** Best-effort Line push to the tenant; never fails a confirm/decline/cancel. */
function pushToTenant(v, text) {
  const lineUserId = v?.tenant_line_user_id || v?.tenant_line_id
  if (!lineUserId || !lineMessaging.isConfigured()) return
  lineMessaging.pushMessage(lineUserId, { type: 'text', text }).catch((err) => {
    logger.error({ err, viewingId: v?.id, lineUserId }, 'viewing confirm/decline tenant push failed')
  })
}
