// src/routes/tenants.js — Admin-only tenant directory (for the matching panel).
//
//   GET   /api/tenants       → list all tenants (requireAdmin)
//   PATCH /api/tenants/:id   → update tenant contact info (requireAdmin)

import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/tenants.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { AppError }     from '../middleware/AppError.js'
import * as viewingsRepo from '../db/repositories/viewings.repo.js'
import * as matchesRepo from '../db/repositories/matches.repo.js'
import * as roomInterest from '../db/repositories/roomInterest.repo.js'

export const tenants = Router()

tenants.use(requireAdmin)

tenants.get('/', asyncHandler(async (_req, res) => {
  res.json(await repo.findAll({ limit: 500 }))
}))

const patchBody = z.object({
  fullName: z.string().trim().min(1).max(160).optional(),
  phone:    z.string().trim().min(8).max(40).optional(),
  email:    z.string().trim().email().max(160).nullable().optional(),
})

const idParam = z.object({ id: z.coerce.number().int().positive() })

/**
 * GET /:id/detail — a tenant and their whole history with us.
 *
 * Before '/:id' handlers so the literal suffix wins. Rooms they asked about
 * come from room_interest, which is the only record of what someone was looking
 * at when they messaged — a viewing or a match only exists once admin acts.
 */
/**
 * Viewing rows come back raw from the repo (snake_case, joined columns). The
 * rest of the API is camelCase, so normalise here rather than leaking column
 * names into the client — the detail panel silently rendered "ห้อง #undefined"
 * off the mismatch.
 */
function shapeViewing(v) {
  return {
    id:           v.id,
    roomId:       v.room_id,
    roomTitle:    v.room_title,
    roomCode:     v.room_code ?? null,
    zone:         v.zone_name_th ?? null,
    tenantId:     v.tenant_id,
    tenantName:   v.tenant_name ?? null,
    scheduledFor: v.scheduled_for,
    status:       v.status,
    note:         v.note ?? null,
  }
}

tenants.get('/:id/detail', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const tenant = await repo.findById(req.params.id)
  if (!tenant) throw new AppError(404, 'TENANT_NOT_FOUND', 'ไม่พบผู้เช่ารายนี้')
  const [viewings, matches, interest] = await Promise.all([
    viewingsRepo.findForTenant(req.params.id).catch(() => []),
    matchesRepo.list({ tenantId: req.params.id, limit: 50 }).catch(() => []),
    // Raw DB row here, so the column is snake_case.
    tenant.line_id ? roomInterest.latestForUser(tenant.line_id).catch(() => null) : null,
  ])
  res.json({ tenant, viewings: viewings.map(shapeViewing), matches, interest })
}))

tenants.patch('/:id', validate({ params: idParam, body: patchBody }),
  asyncHandler(async (req, res) => {
    await repo.updateTenantProfile(req.params.id, req.body)
    const { rows } = await import('../db/pool.js').then(({ pool }) =>
      pool.query('SELECT id, full_name, phone, email, line_id, source FROM tenants WHERE id = $1', [req.params.id]),
    )
    if (!rows[0]) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } })
    res.json(rows[0])
  }),
)

// Hard-delete a tenant account. FK cascades remove their matches / viewings /
// sessions (all tenant-owned). Irreversible — the client confirms first.
tenants.delete('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const ok = await repo.remove(req.params.id)
  if (!ok) throw new AppError(404, 'TENANT_NOT_FOUND', 'ไม่พบผู้เช่านี้')
  res.status(204).end()
}))
