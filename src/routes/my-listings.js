// src/routes/my-listings.js — Landlord's own room inventory.
//
//   GET    /api/my-listings       — list
//   GET    /api/my-listings/:id   — single
//   POST   /api/my-listings       — create (landlord_id from session)
//   PATCH  /api/my-listings/:id   — update (only own rooms)
//   DELETE /api/my-listings/:id   — delete (only own rooms)
//
// Mirrors the admin rooms CRUD but uses requireLandlord + landlord_id scoping.

import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/rooms.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { AppError }     from '../middleware/AppError.js'
import { requireLandlord } from '../auth/middleware.js'

export const myListings = Router()

const writeBody = z.object({
  zoneId:        z.coerce.number().int().positive('กรุณาเลือกโซน'),
  title:         z.string().trim().min(2, 'กรุณากรอกชื่อห้อง').max(200),
  description:   z.string().max(5000).optional().or(z.literal('')),
  propertyType:  z.enum(['condo', 'house', 'townhouse', 'apartment', 'studio']),
  bedrooms:      z.coerce.number().int().min(0).max(10),
  bathrooms:     z.coerce.number().int().min(0).max(10),
  sizeSqm:       z.coerce.number().min(1).max(2000).optional(),
  monthlyRent:   z.coerce.number().int().min(1000).max(1_000_000),
  status:        z.enum(['available', 'reserved', 'matched', 'inactive']).optional(),
  availableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'รูปแบบวันที่ไม่ถูกต้อง').optional().or(z.literal('')),
  amenities:     z.array(z.string().trim().min(1)).max(50).optional(),
  isFeatured:    z.boolean().optional(),
  lat:           z.coerce.number().min(-90).max(90).optional(),
  lng:           z.coerce.number().min(-180).max(180).optional(),
  address:       z.string().trim().max(300).optional().or(z.literal('')),
})

const idParam = z.object({ id: z.coerce.number().int().positive() })

myListings.get('/', requireLandlord, asyncHandler(async (req, res) => {
  const items = await repo.findByLandlord(req.landlord.id)
  res.json(items)
}))

myListings.get('/:id', requireLandlord, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const room = await repo.findOneForLandlord(req.params.id, req.landlord.id)
    if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องนี้')
    res.json(room)
  }),
)

myListings.post('/', requireLandlord, validate({ body: writeBody }),
  asyncHandler(async (req, res) => {
    const room = await repo.createForLandlord({
      ...req.body,
      landlordId: req.landlord.id,
    })
    res.status(201).json(room)
  }),
)

myListings.patch('/:id', requireLandlord,
  validate({ params: idParam, body: writeBody.partial() }),
  asyncHandler(async (req, res) => {
    const updated = await repo.updateForLandlord(req.params.id, req.landlord.id, req.body)
    if (!updated) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องนี้')
    res.json(updated)
  }),
)

myListings.delete('/:id', requireLandlord, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const ok = await repo.deleteForLandlord(req.params.id, req.landlord.id)
    if (!ok) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องนี้')
    res.status(204).end()
  }),
)