// src/routes/rooms.js — Listing + detail for rooms + admin approval + viewing slots.
import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/rooms.repo.js'
import * as slotsRepo from '../db/repositories/viewingSlots.repo.js'
import * as roomImages from '../db/repositories/roomImages.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../middleware/AppError.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { logger } from '../logger.js'
import * as lineMessaging from '../linebot/lineMessaging.service.js'

export const rooms = Router()

const listQuery = z.object({
  zone:    z.string().optional(),
  type:    z.string().optional(),
  maxRent: z.coerce.number().int().positive().optional(),
  minRent: z.coerce.number().int().nonnegative().optional(),
  beds:    z.coerce.number().int().nonnegative().optional(),
  bounds:  z.string().optional(),
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
// Accepts ISO-8601 (with or without timezone) — datetime-local → ISO conversion
// happens client-side. Postgres will reject anything that isn't a real timestamp.
const slotBody = z.object({ startsAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: 'รูปแบบวันที่ไม่ถูกต้อง' }) })

rooms.get('/', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  res.json(await repo.findAvailable(req.query))
}))

// ----- Admin approval flow (Phase 5) — /pending before /:id ---------------

rooms.get('/pending', requireAdmin, asyncHandler(async (_req, res) => {
  res.json(await repo.findPending({ limit: 200 }))
}))

rooms.get('/:id', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const room = await repo.findById(req.params.id)
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องนี้')
  await repo.bumpViewCount(req.params.id)
  // Attach the full photo gallery (room_images, sorted). `room.image` is only
  // the first photo; the gallery + lightbox need the whole set.
  const photos = (await roomImages.findByRoom(req.params.id)).map((p) => p.url)
  res.json({ ...room, photos })
}))

// ----- Viewing slots (Phase 6) ---------------------------------------------
// GET is public (the bot + anyone browsing can see open times); writes are admin.

rooms.get('/:id/slots', validate({ params: idParam }), asyncHandler(async (req, res) => {
  res.json(await slotsRepo.openForRoom(req.params.id))
}))

rooms.post('/:id/slots', requireAdmin, validate({ params: idParam, body: slotBody }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await slotsRepo.create({ roomId: req.params.id, startsAt: req.body.startsAt }))
  }),
)

rooms.delete('/slots/:id', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const ok = await slotsRepo.cancel(req.params.id)
    if (!ok) throw new AppError(404, 'SLOT_NOT_FOUND', 'ไม่พบช่วงเวลา หรือถูกจองไปแล้ว')
    res.status(204).end()
  }),
)

// ----- Authenticated write endpoints (admin room CRUD) --------------------

rooms.post('/', requireAdmin, validate({ body: writeBody }), asyncHandler(async (req, res) => {
  res.status(201).json(await repo.create(req.body))
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

// ----- Admin approval actions (Phase 5) ------------------------------------

rooms.post('/:id/approve', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const approver = `admin:${req.admin?.username ?? 'unknown'}`
    const room = await repo.approve(req.params.id, approver)
    if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องที่รออนุมัติ')
    pushToLandlord(room, `🎉 ประกาศ "${room.title}" อนุมัติแล้วค่ะ ตอนนี้ขึ้นบนเว็บแล้ว ผู้เช่าจะเห็นและนัดชมได้เลยค่ะ`)
    res.json(room)
  }),
)

rooms.post('/:id/reject', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const room = await repo.reject(req.params.id)
    if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องที่รออนุมัติ')
    pushToLandlord(room, `ประกาศ "${room.title}" ยังไม่ผ่านการอนุมัตินะคะ รบกวนแชทกลับแอดมินเพื่อแก้ไขรายละเอียดเพิ่มเติมค่ะ`)
    res.json(room)
  }),
)

/** Best-effort Line push to the submitting landlord; never fails an approve/reject. */
function pushToLandlord(room, text) {
  const lineUserId = room?.createdByLineUserId
  if (!lineUserId || !lineMessaging.isConfigured()) return
  lineMessaging.pushMessage(lineUserId, { type: 'text', text }).catch((err) => {
    logger.error({ err, roomId: room?.id, lineUserId }, 'approve/reject landlord push failed')
  })
}
