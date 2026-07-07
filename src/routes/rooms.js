// src/routes/rooms.js — Listing + detail for rooms.
import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/rooms.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../middleware/AppError.js'
import { requireAdmin } from '../middleware/requireAdmin.js'

export const rooms = Router()

const listQuery = z.object({
  zone:    z.string().optional(),
  type:    z.string().optional(),
  maxRent: z.coerce.number().int().positive().optional(),
  minRent: z.coerce.number().int().nonnegative().optional(),
  limit:   z.coerce.number().int().positive().max(200).optional(),
})

const writeBody = z.object({
  landlordId:    z.coerce.number().int().positive(),
  zoneId:        z.coerce.number().int().positive(),
  title:         z.string().trim().min(2, 'กรุณากรอกชื่อห้อง').max(200),
  description:   z.string().max(5000).optional().or(z.literal('')),
  propertyType:  z.enum(['condo', 'house', 'townhouse', 'apartment', 'studio']),
  bedrooms:      z.coerce.number().int().min(0).max(10),
  bathrooms:     z.coerce.number().int().min(0).max(10),
  sizeSqm:       z.coerce.number().min(1).max(2000).optional(),
  monthlyRent:   z.coerce.number().int().min(1000).max(1_000_000),
  status:        z.enum(['available', 'reserved', 'matched', 'inactive']).optional(),
  availableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'รูปแบบวันที่ไม่ถูกต้อง (YYYY-MM-DD)').optional().or(z.literal('')),
  amenities:     z.array(z.string().trim().min(1)).max(50).optional(),
  isFeatured:    z.boolean().optional(),
})

const idParam = z.object({ id: z.coerce.number().int().positive() })

rooms.get('/', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  const items = await repo.findAvailable(req.query)
  res.json(items)
}))

rooms.get('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const id = req.params.id
  const room = await repo.findById(id)
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องนี้')
  await repo.bumpViewCount(id)
  res.json(room)
}))

// ----- Authenticated write endpoints -----

rooms.post('/', requireAdmin, validate({ body: writeBody }), asyncHandler(async (req, res) => {
  const room = await repo.create(req.body)
  res.status(201).json(room)
}))

rooms.patch('/:id', requireAdmin,
  validate({ params: idParam, body: writeBody.partial() }),
  asyncHandler(async (req, res) => {
    const updated = await repo.update(req.params.id, req.body)
    if (!updated) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องนี้')
    res.json(updated)
  }),
)

rooms.delete('/:id', requireAdmin, validate({ params: idParam }), asyncHandler(async (req, res) => {
  const ok = await repo.remove(req.params.id)
  if (!ok) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องนี้')
  res.status(204).end()
}))