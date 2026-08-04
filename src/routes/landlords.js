// src/routes/landlords.js — Landlord management.
import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/landlords.repo.js'
import * as claims from '../db/repositories/landlordClaims.repo.js'
import { config } from '../config.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../middleware/AppError.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import * as roomsRepo from '../db/repositories/rooms.repo.js'
import * as viewingsRepo from '../db/repositories/viewings.repo.js'

// Build the landlord-facing claim URL. It must hit the BACKEND's /auth/line/start
// (which redirects to LINE) — derive that base from the registered LINE redirect
// URI so it's always the right origin + path prefix as the working callback.
function claimStartUrl(rawToken) {
  const base = config.LINE_LOGIN_REDIRECT_URI
    ? config.LINE_LOGIN_REDIRECT_URI.replace(/\/line\/callback\/?$/, '/line/start')
    : `${(config.APP_BASE_URL || '').replace(/\/+$/, '')}/api/auth/line/start`
  return `${base}?role=landlord&claim=${encodeURIComponent(rawToken)}`
}

export const landlords = Router()

// Landlord directory + edits are admin-only: the list exposes every landlord's
// phone/email/Line ID/tax ID, and PATCH can deactivate or rewrite any landlord.
landlords.use(requireAdmin)

const listQuery = z.object({
  isActive: z.coerce.boolean().optional(),
  limit:    z.coerce.number().int().positive().max(200).optional(),
})

const idParam = z.object({ id: z.coerce.number().int().positive() })

// Admin-created landlords (legacy owners onboarded manually). fullName + phone
// are required; line_id is optional and usually omitted — the LINE identity is
// bound later, not at intake (see docs/LEGACY_LANDLORD_ONBOARDING.md).
const createBody = z.object({
  fullName:    z.string().trim().min(1, 'กรุณากรอกชื่อเจ้าของห้อง').max(160),
  phone:       z.string().trim().min(8, 'เบอร์โทรไม่ถูกต้อง').max(40),
  email:       z.string().trim().email('อีเมลไม่ถูกต้อง').max(160).nullable().optional(),
  lineId:      z.string().trim().max(80).nullable().optional(),
  companyName: z.string().trim().max(160).nullable().optional(),
  taxId:       z.string().trim().max(40).nullable().optional(),
  note:        z.string().trim().max(1000).nullable().optional(),
  // Who to actually call. The owner is often not the person who answers: an
  // adult child registers for a parent, a spouse handles viewings, an agent
  // fronts for the owner. Blank means the owner is their own contact.
  contactName:     z.string().trim().max(160).nullable().optional(),
  contactPhone:    z.string().trim().max(40).nullable().optional(),
  // Free text, not an enum. The LIFF form offers "อื่นๆ (ระบุ)" so the value is
  // whatever the person typed; an enum would have rejected the very submissions
  // that form produces, and only at the point an admin later edited them.
  contactRelation: z.string().trim().max(60).nullable().optional(),
})

const patchBody = z.object({
  fullName:    z.string().trim().min(1).max(160).optional(),
  phone:       z.string().trim().min(8).max(40).optional(),
  email:       z.string().trim().email().max(160).nullable().optional(),
  lineId:      z.string().trim().max(80).nullable().optional(),
  companyName: z.string().trim().max(160).nullable().optional(),
  taxId:       z.string().trim().max(40).nullable().optional(),
  note:        z.string().trim().max(1000).nullable().optional(),
  isActive:    z.boolean().optional(),
  // Who to actually call. The owner is often not the person who answers: an
  // adult child registers for a parent, a spouse handles viewings, an agent
  // fronts for the owner. Blank means the owner is their own contact.
  contactName:     z.string().trim().max(160).nullable().optional(),
  contactPhone:    z.string().trim().max(40).nullable().optional(),
  // Free text, not an enum. The LIFF form offers "อื่นๆ (ระบุ)" so the value is
  // whatever the person typed; an enum would have rejected the very submissions
  // that form produces, and only at the point an admin later edited them.
  contactRelation: z.string().trim().max(60).nullable().optional(),
})

/**
 * GET /:id/detail — a landlord and everything attached to them.
 *
 * Declared before any other '/:id' route so the literal suffix wins. Rooms come
 * from findByLandlord (every status — an admin looking at an owner wants the
 * reserved ones too, which is the whole point of opening this).
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

landlords.get('/:id/detail', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const landlord = await repo.findById(req.params.id)
  if (!landlord) throw new AppError(404, 'LANDLORD_NOT_FOUND', 'ไม่พบเจ้าของห้องนี้')
  const [rooms, viewings] = await Promise.all([
    roomsRepo.findByLandlord(req.params.id),
    viewingsRepo.findForLandlord(req.params.id).catch(() => []),
  ])
  res.json({ landlord, rooms, viewings: viewings.map(shapeViewing) })
}))

landlords.get('/', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  res.json(await repo.list(req.query))
}))

landlords.post('/', validate({ body: createBody }), asyncHandler(async (req, res) => {
  // If a lineId is supplied, refuse to create a second landlord bound to the same
  // LINE identity — that would fork one owner into two rows. (The DB-level unique
  // index arrives with Phase 0 of the legacy-onboarding plan; this guard gives a
  // friendly 409 in the meantime.)
  if (req.body.lineId) {
    const existing = await repo.findByLineId(req.body.lineId)
    if (existing) {
      throw new AppError(409, 'LANDLORD_LINE_EXISTS', 'มีเจ้าของห้องที่ผูกกับ Line ID นี้อยู่แล้ว')
    }
  }
  res.status(201).json(await repo.create(req.body))
}))

landlords.get('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const l = await repo.findById(req.params.id)
  if (!l) throw new AppError(404, 'LANDLORD_NOT_FOUND', 'ไม่พบเจ้าของห้องนี้')
  res.json(l)
}))

landlords.patch('/:id', validate({ params: idParam, body: patchBody }), asyncHandler(async (req, res) => {
  const updated = await repo.update(req.params.id, req.body)
  if (!updated) throw new AppError(404, 'LANDLORD_NOT_FOUND', 'ไม่พบเจ้าของห้องนี้')
  res.json(updated)
}))

// Generate a one-time claim link so the landlord can bind their LINE account to
// this row. Refuses if the landlord is already linked, unless ?force=true (the
// owner switched LINE accounts).
landlords.post('/:id/claim-link', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const l = await repo.findById(req.params.id)
  if (!l) throw new AppError(404, 'LANDLORD_NOT_FOUND', 'ไม่พบเจ้าของห้องนี้')
  const force = req.query.force === 'true' || req.query.force === '1'
  if (l.lineId && !force) {
    throw new AppError(409, 'LANDLORD_ALREADY_LINKED',
      'เจ้าของห้องนี้เชื่อมกับ LINE อยู่แล้ว (ใช้ ?force=true เพื่อออกลิงก์ใหม่)')
  }
  const { rawToken, claim } = await claims.create(l.id, req.admin?.id ?? null, 14)
  res.status(201).json({ url: claimStartUrl(rawToken), expiresAt: claim.expiresAt })
}))

landlords.delete('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const l = await repo.findById(req.params.id)
  if (!l) throw new AppError(404, 'LANDLORD_NOT_FOUND', 'ไม่พบเจ้าของห้องนี้')
  // Refuse if the landlord still owns rooms — the rooms FK is ON DELETE CASCADE,
  // so deleting would silently take the rooms too. Admin must move/remove the
  // rooms first (this is the safe path for cleaning up a mistaken/duplicate row,
  // which has no rooms).
  if ((l.roomCount ?? 0) > 0) {
    throw new AppError(409, 'LANDLORD_HAS_ROOMS',
      `ลบไม่ได้ — เจ้าของห้องนี้มี ${l.roomCount} ห้องอยู่ กรุณาย้าย/ลบห้องก่อน`)
  }
  await repo.remove(req.params.id)
  res.status(204).end()
}))
