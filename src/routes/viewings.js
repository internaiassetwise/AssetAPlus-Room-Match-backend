// src/routes/viewings.js — Tenant-facing calendar (วันนัดชมห้อง) API.
//
//   POST /api/viewings             — tenant schedules a viewing
//   GET  /api/viewings?role=tenant  — tenant's own viewings
//   GET  /api/viewings?role=landlord — landlord's incoming requests
//   PATCH /api/viewings/:id        — landlord confirm/decline, tenant cancel

import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/viewings.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { AppError }     from '../middleware/AppError.js'
import { requireUser, requireLandlord } from '../auth/middleware.js'

export const viewings = Router()

const createBody = z.object({
  roomId:       z.coerce.number().int().positive('กรุณาระบุห้อง'),
  scheduledFor: z.string().datetime({ message: 'วันเวลาไม่ถูกต้อง (ISO 8601)' })
                  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'รูปแบบวันเวลาไม่ถูกต้อง')),
  note:         z.string().trim().max(500).optional().or(z.literal('')),
})

const patchBody = z.object({
  status:        z.enum(['confirmed', 'declined', 'completed', 'cancelled']).optional(),
  landlordNote:  z.string().trim().max(500).optional().or(z.literal('')),
  note:          z.string().trim().max(500).optional().or(z.literal('')),
}).refine((b) => Object.keys(b).length > 0, { message: 'ไม่มีข้อมูลให้อัปเดต' })

const idParam = z.object({ id: z.coerce.number().int().positive() })

/**
 * Tenant creates a viewing request.
 *   body: { roomId, scheduledFor, note }
 *   Identity: from requireUser → req.user.id (skip in MOCK mode).
 */
viewings.post('/', requireUser, validate({ body: createBody }), asyncHandler(async (req, res) => {
  const room = await repo.findById(req.body.roomId)
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องนี้')
  const viewing = await repo.createRequest({
    roomId:       req.body.roomId,
    tenantId:     req.user.id,
    scheduledFor: req.body.scheduledFor,
    note:         req.body.note,
  })
  res.status(201).json(viewing)
}))

/**
 * List viewings for the caller.
 *   ?role=tenant    → requireUser, shows own
 *   ?role=landlord  → requireLandlord, shows incoming
 */
viewings.get('/', asyncHandler(async (req, res) => {
  const role = String(req.query.role || 'tenant')
  const status = req.query.status ? String(req.query.status) : undefined

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