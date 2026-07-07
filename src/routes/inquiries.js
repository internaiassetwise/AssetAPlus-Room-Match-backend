// src/routes/inquiries.js — Tenant → landlord room inbox.
//
//   POST /api/inquiries          — tenant sends a message
//   GET  /api/inquiries?role=landlord — landlord's inbox
//   GET  /api/inquiries?role=tenant   — tenant's own sent messages
//   PATCH /api/inquiries/:id     — landlord replies / closes

import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/inquiries.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { AppError }     from '../middleware/AppError.js'
import { requireUser, requireLandlord } from '../auth/middleware.js'

export const inquiries = Router()

const createBody = z.object({
  roomId:  z.coerce.number().int().positive('กรุณาระบุห้อง'),
  message: z.string().trim().min(5, 'กรุณาพิมพ์ข้อความอย่างน้อย 5 ตัวอักษร').max(1000),
})

const patchBody = z.object({
  reply:   z.string().trim().min(1).max(1000).optional(),
  close:   z.boolean().optional(),
}).refine((b) => b.reply || b.close, { message: 'กรุณาพิมพ์ข้อความตอบกลับ หรือเลือกปิดรายการ' })

const idParam = z.object({ id: z.coerce.number().int().positive() })

/** Tenant sends a message to a room's landlord. */
inquiries.post('/', requireUser, validate({ body: createBody }), asyncHandler(async (req, res) => {
  const room = await repo.findById(req.body.roomId) // reuses join (cheap)
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องนี้')
  const item = await repo.create({
    roomId:   req.body.roomId,
    tenantId: req.user.id,
    message:  req.body.message,
  })
  res.status(201).json(item)
}))

/** List inquiries for the caller. */
inquiries.get('/', asyncHandler(async (req, res) => {
  const role   = String(req.query.role || 'landlord')
  const status = req.query.status ? String(req.query.status) : undefined

  if (role === 'landlord') {
    await runMiddleware(requireLandlord, req, res)
    const items = await repo.findForLandlord(req.landlord.id, { status })
    return res.json(items)
  }
  if (role !== 'tenant') throw new AppError(400, 'BAD_ROLE', 'ระบุ role=tenant หรือ role=landlord')

  await runMiddleware(requireUser, req, res)
  const items = await repo.findForTenant(req.user.id)
  return res.json(items)
}))

/** Landlord replies (status→replied) or closes (status→closed). */
inquiries.patch('/:id', requireLandlord, validate({ params: idParam, body: patchBody }),
  asyncHandler(async (req, res) => {
    if (req.body.reply) {
      const updated = await repo.reply(req.params.id, req.body.reply)
      if (!updated) throw new AppError(404, 'INQUIRY_NOT_FOUND', 'ไม่พบข้อความนี้')
      return res.json(updated)
    }
    if (req.body.close) {
      const ok = await repo.close(req.params.id)
      if (!ok) throw new AppError(404, 'INQUIRY_NOT_FOUND', 'ไม่พบข้อความนี้')
      return res.status(204).end()
    }
    // refine() above ensures one of these is set, but guard anyway.
    throw new AppError(400, 'NOOP', 'ไม่มีการเปลี่ยนแปลง')
  }),
)

function runMiddleware(mw, req, res) {
  return new Promise((resolve, reject) => mw(req, res, (err) => err ? reject(err) : resolve()))
}