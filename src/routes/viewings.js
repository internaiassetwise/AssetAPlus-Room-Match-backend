// src/routes/viewings.js — Tenant-facing calendar (วันนัดชมห้อง) API.
//
//   POST /api/viewings             — DISABLED: tenants request viewings via Line
//   GET  /api/viewings?role=tenant  — tenant's own viewings
//   GET  /api/viewings?role=landlord — landlord's incoming requests
//   PATCH /api/viewings/:id        — landlord confirm/decline, tenant cancel
//
// Under the middleman workflow, dates are set by admin (e.g. via the Line
// chatbot) and tenants contact admin to request a slot. The endpoint stays
// mounted so a stale frontend tab gets a clear 403 instead of a 404.

import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/viewings.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { AppError }     from '../middleware/AppError.js'
import { requireUser, requireLandlord } from '../auth/middleware.js'

export const viewings = Router()

const patchBody = z.object({
  status:        z.enum(['confirmed', 'declined', 'completed', 'cancelled']).optional(),
  landlordNote:  z.string().trim().max(500).optional().or(z.literal('')),
  note:          z.string().trim().max(500).optional().or(z.literal('')),
}).refine((b) => Object.keys(b).length > 0, { message: 'ไม่มีข้อมูลให้อัปเดต' })

const idParam = z.object({ id: z.coerce.number().int().positive() })

/**
 * Tenants request viewings via Line — they do not self-book in the app.
 * Endpoint kept so a stale frontend tab receives a clear 403 CONTACT_ADMIN.
 */
viewings.post('/', requireUser, asyncHandler(async (_req, _res) => {
  throw new AppError(
    403,
    'CONTACT_ADMIN',
    'การนัดชมห้องต้องติดต่อแอดมินทาง Line เพื่อยืนยันวันเวลา',
  )
}))

/**
 * List viewings for the caller.
 *   ?role=tenant           → requireUser, shows own
 *   ?role=landlord         → requireLandlord, shows incoming
 *   ?roomId=<id>&public=1  → PUBLIC: confirmed + future viewings for one room
 *                            (no auth required — used by RoomDetail to display
 *                            admin-set viewing dates to anyone browsing)
 */
viewings.get('/', asyncHandler(async (req, res) => {
  const role = String(req.query.role || 'tenant')
  const status = req.query.status ? String(req.query.status) : undefined

  // Public per-room read for AvailableViewingDates on RoomDetail.
  if (req.query.roomId && String(req.query.public) === '1') {
    const roomId = Number(req.query.roomId)
    if (!Number.isInteger(roomId) || roomId <= 0) {
      throw new AppError(400, 'BAD_ROOM_ID', 'ระบุ roomId ไม่ถูกต้อง')
    }
    const items = await repo.findForRoomPublic(roomId)
    return res.json(items)
  }

  if (role === 'landlord') {
    const { requireLandlord: rl } = await import('../auth/middleware.js')
    await new Promise((resolve, reject) => rl(req, res, e => e ? reject(e) : resolve()))
    const items = await repo.findForLandlord(req.landlord.id, { status })
    return res.json(items)
  }
  if (role !== 'tenant') throw new AppError(400, 'BAD_ROLE', 'ระบุ role=tenant หรือ role=landlord')

  const { requireUser: ru } = await import('../auth/middleware.js')
  await new Promise((resolve, reject) => ru(req, res, e => e ? reject(e) : resolve()))
  const items = await repo.findForTenant(req.user.id, { status })
  return res.json(items)
}))

/**
 * Update viewing status.
 *   - landlord: status ∈ {confirmed, declined, completed} (+ landlord_note)
 *   - tenant:   status ∈ {cancelled}
 */
viewings.patch('/:id', validate({ params: idParam, body: patchBody }),
  asyncHandler(async (req, res) => {
    const item = await repo.findById(req.params.id)
    if (!item) throw new AppError(404, 'VIEWING_NOT_FOUND', 'ไม่พบรายการนัดชมห้องนี้')

    const wantsLandlordAction = ['confirmed', 'declined', 'completed'].includes(req.body.status)
    const wantsTenantAction   = req.body.status === 'cancelled'

    if (wantsLandlordAction) {
      await runMiddleware(requireLandlord, req, res)
      // Tenant cancellation is not gated through here — landlord_note ignored.
      const updated = await repo.updateStatus(req.params.id, {
        status:       req.body.status,
        landlordNote: req.body.landlordNote,
      })
      return res.json(updated)
    }
    if (wantsTenantAction) {
      await runMiddleware(requireUser, req, res)
      if (item.tenant_id !== req.user.id) {
        throw new AppError(403, 'NOT_OWNER', 'คุณไม่ใช่เจ้าของรายการนี้')
      }
      const updated = await repo.updateStatus(req.params.id, { status: 'cancelled' })
      return res.json(updated)
    }
    // Otherwise allow a tenant to edit their own note before confirmation.
    await runMiddleware(requireUser, req, res)
    if (item.tenant_id !== req.user.id) {
      throw new AppError(403, 'NOT_OWNER', 'คุณไม่ใช่เจ้าของรายการนี้')
    }
    const updated = await repo.updateStatus(req.params.id, { note: req.body.note })
    return res.json(updated)
  }),
)

/** Run an Express middleware as a promise — used to gate a route conditionally. */
function runMiddleware(mw, req, res) {
  return new Promise((resolve, reject) => mw(req, res, (err) => err ? reject(err) : resolve()))
}