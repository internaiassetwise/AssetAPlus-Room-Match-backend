// src/routes/viewings.js — Tenant-facing calendar (วันนัดชมห้อง) API.
//
//   POST /api/viewings             — DISABLED for human tenants (403 CONTACT_ADMIN).
//                                  Enabled with X-Bot-Secret: the Line bot books
//                                  the slot on the tenant's behalf.
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
import * as tenantRepo from '../db/repositories/tenants.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { requireBot }   from '../middleware/requireBot.js'
import { AppError }     from '../middleware/AppError.js'
import { requireUser, requireLandlord } from '../auth/middleware.js'
import { config }       from '../config.js'

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
 *
 * Bot bypass: with X-Bot-Secret + X-Bot-LineUserId we look up (or create) the
 * tenant stub and POST a viewing in their name. Status starts as 'requested'
 * so the dashboard sees a normal flow.
 */
viewings.post('/', asyncHandler(async (req, res) => {
  const isBot = !!req.headers['x-bot-secret']
  if (!isBot) {
    await new Promise((resolve, reject) =>
      requireUser(req, res, (err) => err ? reject(err) : resolve()))
    throw new AppError(
      403,
      'CONTACT_ADMIN',
      'การนัดชมห้องต้องติดต่อแอดมินทาง Line เพื่อยืนยันวันเวลา',
    )
  }

  await new Promise((resolve, reject) =>
    requireBot(req, res, (err) => err ? reject(err) : resolve()))

  const body = z.object({
    roomId:           z.coerce.number().int().positive(),
    tenantLineUserId: z.string().min(1),
    scheduledAt:      z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/),
    note:             z.string().max(500).optional().or(z.literal('')),
  }).parse(req.body)

  const lineUserId = req.bot?.lineUserId || body.tenantLineUserId

  // Find or create the tenant stub.
  let tenant = await tenantRepo.findByLineId(lineUserId)
  if (!tenant) tenant = await tenantRepo.createFromBot(lineUserId)

  const created = await repo.createForTenant({
    tenantId:           tenant.id,
    tenantLineUserId:   lineUserId,        // cached for the bot's confirm-viewing flow
    roomId:             body.roomId,
    scheduledFor:       body.scheduledAt,
    note:               body.note || '',
  })
  res.status(201).json(created)
}))

/**
 * GET /api/viewings/:id — bot pulls a single viewing so it can render the
 * confirmation Flex and know which Line user to push to. Gated by
 * X-Bot-Secret so the public can't enumerate viewing IDs.
 */
viewings.get('/:id',
  requireBot,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const item = await repo.findById(req.params.id)
    if (!item) throw new AppError(404, 'VIEWING_NOT_FOUND', 'ไม่พบรายการนัดชมห้องนี้')
    res.json(item)
  }),
)

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
    // Whitelist fields before responding — this route is unauthenticated, so
    // even though findForRoomPublic now uses a minimal SELECT we strip to just
    // the viewing-date fields a public browser needs (never tenant PII/notes).
    const items = (await repo.findForRoomPublic(roomId))
      .map(({ id, scheduled_for, status }) => ({ id, scheduled_for, status }))
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

      // Push the confirmation to the tenant via the Line bot when the status
      // flips to 'confirmed'. Failures here are logged but don't fail the
      // landlord's PATCH — DB state is already updated, admin can retry.
      if (req.body.status === 'confirmed' && updated?.tenant_line_user_id) {
        await notifyBotOfConfirmation(updated).catch((err) =>
          req.log?.error?.(err) ??
            // eslint-disable-next-line no-console
            console.error('[viewings] bot push failed:', err.message))
      }

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

/**
 * Fire-and-log POST to the bot's /api/admin/confirm-viewing so the tenant
 * gets a Flex confirmation pushed to them on Line. Best-effort: we log
 * and move on so a bot outage doesn't break the landlord's confirmation
 * flow.
 */
async function notifyBotOfConfirmation(viewing) {
  const botBaseUrl = config.ROOM_MATCH_BOT_URL
  const botSecret  = config.BOT_SHARED_SECRET
  if (!botBaseUrl || !botSecret) {
    // eslint-disable-next-line no-console
    console.warn('[viewings] ROOM_MATCH_BOT_URL / BOT_SHARED_SECRET not set — skipping bot push')
    return
  }

  const res = await fetch(`${botBaseUrl}/api/admin/confirm-viewing`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bot-Secret': botSecret,
    },
    body: JSON.stringify({ viewingId: viewing.id }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`bot push failed: ${res.status} ${err}`)
  }
}