// src/routes/adminViewings.js — Admin confirmation of tenant viewing requests.
//
// A tenant books a viewing slot through the Line chatbot (a postback) → a
// viewings row is created at status='requested'. That booking is only
// provisional until an admin acts on it here:
//   confirm → status='confirmed' + a Line push to the tenant
//   decline → status='declined', the slot reopens for someone else, and the
//             tenant is pushed a "please pick another time" message
//
//   GET   /api/admin/viewings             (admin) → list (default status=requested)
//   POST  /api/admin/viewings/:id/confirm (admin)
//   POST  /api/admin/viewings/:id/decline (admin)
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

adminViewings.post('/:id/confirm', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const v = await viewings.updateStatus(req.params.id, { status: 'confirmed' })
    if (!v) throw new AppError(404, 'VIEWING_NOT_FOUND', 'ไม่พบคำขอนัดชมนี้')
    pushToTenant(v, `✅ ยืนยันนัดชมห้อง "${v.room_title}" แล้วค่ะ เจอกัน ${bangkok(v.scheduled_for)} นะคะ`)
    logger.info({ viewingId: v.id, admin: req.admin?.username }, 'viewing confirmed by admin')
    res.json(mapRow(v))
  }),
)

adminViewings.post('/:id/decline', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const v = await viewings.updateStatus(req.params.id, { status: 'declined' })
    if (!v) throw new AppError(404, 'VIEWING_NOT_FOUND', 'ไม่พบคำขอนัดชมนี้')
    // Free the slot so another tenant can book it; safe no-op if already gone.
    await viewingSlots.reopenByViewing(req.params.id)
    pushToTenant(v, `ขออภัยค่ะ คุณแอดมินต้องเลื่อนนัดชมห้อง "${v.room_title}" รบกวนเลือกเวลาใหม่ได้เลยนะคะ 🙏`)
    logger.info({ viewingId: v.id, admin: req.admin?.username }, 'viewing declined by admin')
    res.json(mapRow(v))
  }),
)

/** Best-effort Line push to the tenant; never fails a confirm/decline. */
function pushToTenant(v, text) {
  const lineUserId = v?.tenant_line_user_id || v?.tenant_line_id
  if (!lineUserId || !lineMessaging.isConfigured()) return
  lineMessaging.pushMessage(lineUserId, { type: 'text', text }).catch((err) => {
    logger.error({ err, viewingId: v?.id, lineUserId }, 'viewing confirm/decline tenant push failed')
  })
}
