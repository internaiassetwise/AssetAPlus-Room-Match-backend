// src/routes/landlords.js — Landlord management.
import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/landlords.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../middleware/AppError.js'
import { requireAdmin } from '../middleware/requireAdmin.js'

export const landlords = Router()

// Landlord directory + edits are admin-only: the list exposes every landlord's
// phone/email/Line ID/tax ID, and PATCH can deactivate or rewrite any landlord.
landlords.use(requireAdmin)

const listQuery = z.object({
  isActive: z.coerce.boolean().optional(),
  limit:    z.coerce.number().int().positive().max(200).optional(),
})

const idParam = z.object({ id: z.coerce.number().int().positive() })

const patchBody = z.object({
  fullName:    z.string().trim().min(1).max(160).optional(),
  phone:       z.string().trim().min(8).max(40).optional(),
  email:       z.string().trim().email().max(160).nullable().optional(),
  lineId:      z.string().trim().max(80).nullable().optional(),
  companyName: z.string().trim().max(160).nullable().optional(),
  taxId:       z.string().trim().max(40).nullable().optional(),
  note:        z.string().trim().max(1000).nullable().optional(),
  isActive:    z.boolean().optional(),
})

landlords.get('/', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  res.json(await repo.list(req.query))
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
