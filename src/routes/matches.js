// src/routes/matches.js — Tenant ⇄ room pairings.
import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/matches.repo.js'
import * as lineMessaging from '../linebot/lineMessaging.service.js'
import { config } from '../config.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../middleware/AppError.js'
import { requireAdmin } from '../middleware/requireAdmin.js'

export const matches = Router()

// Matching is an admin/internal operation — the responses carry tenant names +
// phones, and POST/PATCH can forge match status (e.g. contract_signed).
matches.use(requireAdmin)

const listQuery = z.object({
  status:   z.enum(['suggested', 'contacted', 'viewing', 'contract_signed', 'rejected']).optional(),
  tenantId: z.coerce.number().int().positive().optional(),
  roomId:   z.coerce.number().int().positive().optional(),
  limit:    z.coerce.number().int().positive().max(200).optional(),
})

matches.get('/', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  res.json(await repo.list(req.query))
}))

matches.get('/suggest', validate({
  query: z.object({
    tenant_id: z.coerce.number().int().positive(),
    limit:     z.coerce.number().int().positive().max(50).optional(),
  }),
}), asyncHandler(async (req, res) => {
  const { tenant_id, limit } = req.query
  res.json(await repo.suggestForTenant(tenant_id, limit || 10))
}))

const createBody = z.object({
  tenantId:   z.coerce.number().int().positive(),
  roomId:     z.coerce.number().int().positive(),
  status:     z.enum(['suggested', 'contacted', 'viewing', 'contract_signed', 'rejected']).optional(),
  matchScore: z.coerce.number().min(0).max(100).optional(),
  agentNote:  z.string().trim().max(2000).optional(),
})

matches.post('/', validate({ body: createBody }), asyncHandler(async (req, res) => {
  const id = await repo.create(req.body)
  res.status(201).json({ ok: true, id })
}))

const patchBody = z.object({
  status:    z.enum(['suggested', 'contacted', 'viewing', 'contract_signed', 'rejected']),
  agentNote: z.string().trim().max(2000).optional(),
})

matches.patch('/:id', validate({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body:   patchBody,
}), asyncHandler(async (req, res) => {
  const updated = await repo.updateStatus(req.params.id, req.body.status, req.body.agentNote)
  if (!updated) throw new AppError(404, 'MATCH_NOT_FOUND', 'ไม่พบรายการ match นี้')
  // Side-effect: keep `rooms.matched_at` in sync so the landing-page stat
  // ('ที่ Match แล้ว') stays accurate without a join. Best-effort — if it
  // fails the match update still wins, the next status flip will retry.
  if (req.body.status === 'contract_signed') {
    try { await repo.markRoomMatched(updated.id) } catch { /* swallow */ }
  }
  res.json({ ok: true, id: updated.id })
}))

const idParam = z.object({ id: z.coerce.number().int().positive() })

// POST /:id/notify — push a LINE message to the tenant about this match.
// Manual (admin-triggered) so admin controls the timing and can re-send.
// Does NOT change the match status — the admin manages that separately.
matches.post('/:id/notify', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const match = await repo.findById(req.params.id)
  if (!match) throw new AppError(404, 'MATCH_NOT_FOUND', 'ไม่พบรายการ match นี้')
  if (!match.tenantLineId) {
    throw new AppError(409, 'TENANT_NO_LINE',
      'ผู้เช่ารายนี้ยังไม่ได้เชื่อม LINE — ส่งแจ้งเตือนไม่ได้ (โทรแจ้งแทนได้)')
  }

  // Public room-detail link on the FRONTEND origin (same one auth.js redirects to).
  const base = (config.WEB_BASE_URL || config.APP_BASE_URL || '').replace(/\/+$/, '')
  const link = base ? `${base}/rooms/${match.roomId}` : null
  const meta = [
    match.roomRent != null ? `฿${Number(match.roomRent).toLocaleString('en-US')}/เดือน` : '',
    match.roomBedrooms != null ? `${match.roomBedrooms} นอน` : '',
    match.zoneName || '',
  ].filter(Boolean).join(' · ')

  const lines = ['🏠 RoomMatch หาห้องที่ตรงกับคุณให้แล้ว!', '', match.roomTitle || 'ห้องพร้อมเข้าอยู่']
  if (meta) lines.push(meta)
  if (link) lines.push('', 'ดูรายละเอียดห้อง 👇', link)
  lines.push('', 'สนใจนัดชมห้องนี้ ทักกลับมาได้เลยครับ 😊')

  await lineMessaging.pushMessage(match.tenantLineId, { type: 'text', text: lines.join('\n') })
  res.json({ ok: true, sent: true })
}))

// DELETE /:id — hard-remove a match (undo an admin mistake). When the tenant
// simply passed on the room, set status='rejected' instead so the history stays.
matches.delete('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const ok = await repo.remove(req.params.id)
  if (!ok) throw new AppError(404, 'MATCH_NOT_FOUND', 'ไม่พบรายการ match นี้')
  res.status(204).end()
}))
