// src/routes/rooms.js — Listing + detail for rooms + admin approval + viewing slots.
import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import * as repo from '../db/repositories/rooms.repo.js'
import * as slotsRepo from '../db/repositories/viewingSlots.repo.js'
import * as roomImages from '../db/repositories/roomImages.repo.js'
import { detectImageExt } from '../services/fileSignature.service.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../middleware/AppError.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { logger } from '../logger.js'
import * as lineMessaging from '../linebot/lineMessaging.service.js'

export const rooms = Router()

// multer in-memory so the handler can inspect bytes + decide its own path.
// Mirrors the bot photo upload in my-listings.js; bytes are validated with
// detectImageExt before being written to disk.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new AppError(400, 'BAD_MIME', 'ต้องเป็นไฟล์รูปภาพ'))
    }
    cb(null, true)
  },
})

const listQuery = z.object({
  zone:    z.string().optional(),
  type:    z.string().optional(),
  roomType:z.string().optional(),
  maxRent: z.coerce.number().int().positive().optional(),
  minRent: z.coerce.number().int().nonnegative().optional(),
  beds:    z.coerce.number().int().nonnegative().optional(),
  bounds:  z.string().optional(),
  limit:   z.coerce.number().int().positive().max(200).optional(),
})

const writeBody = z.object({
  landlordId:    z.coerce.number().int().positive().optional(),
  zoneId:        z.coerce.number().int().positive(),
  title:         z.string().trim().min(2, 'กรุณากรอกชื่อห้อง').max(200),
  description:   z.string().max(5000).optional().or(z.literal('')),
  propertyType:  z.enum(['condo', 'house', 'townhouse', 'apartment', 'studio']).optional(),
  roomType:      z.string().trim().max(60).optional().nullable(),
  projectName:   z.string().trim().max(200).optional().nullable(),
  roomCode:      z.string().trim().max(60).optional().nullable(),
  building:      z.string().trim().max(40).optional().nullable(),
  floor:         z.coerce.number().int().min(-10).max(200).optional().nullable(),
  viewType:      z.string().trim().max(60).optional().nullable(),
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
  res.json((await repo.findAvailable(req.query)).map(publicRoom))
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
  res.json({ ...publicRoom(room), photos })
}))

/**
 * Drop internal/PII fields before returning a room to a PUBLIC (unauthenticated)
 * reader: the landlord's Line userId (createdByLineUserId) is an identity key,
 * and approvedBy leaks an admin username. Admin routes still get the full row.
 */
function publicRoom(room) {
  if (!room) return room
  const { createdByLineUserId, approvedBy, ...rest } = room
  return rest
}

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

/**
 * GET /:id/photos — admin photo list with IDs (for the room form's photo
 * manager). The public GET /:id already returns photos as plain URL strings,
 * but the admin form needs IDs to delete individual photos.
 */
rooms.get('/:id/photos', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await roomImages.findByRoom(req.params.id))
  }),
)

/**
 * POST /:id/photos — admin photo upload from the room form.
 *
 * Multipart/form-data with a single `photo` field. Validates bytes via
 * detectImageExt (rejects anything that isn't jpg/png/webp/gif), writes to
 * uploads/rooms/{id}/, inserts a room_images row, returns the public URL.
 *
 * Authentication: requireAdmin. The admin room form calls this after the room
 * has been created (create mode) or anytime (edit mode).
 */
rooms.post('/:id/photos', requireAdmin, validate({ params: idParam }), photoUpload.single('photo'),
  asyncHandler(async (req, res) => {
    const roomId = Number(req.params.id)
    const room = await repo.findById(roomId)
    if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องนี้')

    if (!req.file) {
      throw new AppError(400, 'NO_FILE', 'กรุณาส่งไฟล์รูปภาพ (field: photo)')
    }

    // Derive the extension from ACTUAL bytes — filename + Content-Type are
    // client-controlled. Rejects non-images to prevent stored XSS via
    // uploaded .html/.svg served from the API origin.
    const ext = detectImageExt(req.file.buffer)
    if (!ext) {
      throw new AppError(400, 'BAD_IMAGE', 'ไฟล์ไม่ใช่รูปภาพที่รองรับ (รองรับ jpg/png/webp/gif)')
    }

    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const crypto = await import('node:crypto')

    const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`
    const dir = path.join(process.cwd(), 'uploads', 'rooms', String(roomId))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, fileName), req.file.buffer)

    // Prefer the configured public origin (reliable behind a proxy); the
    // req.protocol fallback is correct now that `trust proxy` is set.
    const origin = (process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')
    const publicUrl = `${origin}/uploads/rooms/${roomId}/${fileName}`

    const row = await roomImages.create(roomId, publicUrl, fileName)
    return res.status(201).json({ url: publicUrl, id: row.id })
  }),
)

/**
 * DELETE /:id/photos/:photoId — admin removes a single photo.
 *
 * Removes the room_images row. The file on disk is left behind (cheap to
 * orphan, risky to delete — but the DB row is the source of truth for the
 * gallery, so it disappears from the UI immediately).
 */
rooms.delete('/:id/photos/:photoId', requireAdmin,
  validate({ params: z.object({ id: z.coerce.number().int().positive(), photoId: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    const ok = await roomImages.removeOne(req.params.photoId, req.params.id)
    if (!ok) throw new AppError(404, 'PHOTO_NOT_FOUND', 'ไม่พบรูปภาพนี้')
    res.status(204).end()
  }),
)

// ----- Admin approval actions (Phase 5) ------------------------------------

rooms.post('/:id/approve', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const approver = req.admin?.displayName || req.admin?.username || 'unknown'
    const approverTag = `@${approver}`
    const room = await repo.approve(req.params.id, `admin:${approver}`)
    if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องที่รออนุมัติ')
    pushToLandlord(room, `🎉 ประกาศ "${room.title}" อนุมัติแล้วค่ะ ตอนนี้ขึ้นบนเว็บแล้ว ผู้เช่าจะเห็นและนัดชมได้เลยค่ะ\n— อนุมัติโดย ${approverTag}`)
    notifyAdminGroup(`✅ [อนุมัติประกาศ]\n"${room.title}"\nอนุมัติโดย: ${approverTag}`)
    res.json(room)
  }),
)

rooms.post('/:id/reject', requireAdmin, validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const rejecter = req.admin?.displayName || req.admin?.username || 'unknown'
    const rejecterTag = `@${rejecter}`
    const room = await repo.reject(req.params.id)
    if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องที่รออนุมัติ')
    pushToLandlord(room, `ประกาศ "${room.title}" ยังไม่ผ่านการอนุมัตินะคะ รบกวนแชทกลับแอดมินเพื่อแก้ไขรายละเอียดเพิ่มเติมค่ะ\n— ปฏิเสธโดย ${rejecterTag}`)
    notifyAdminGroup(`❌ [ปฏิเสธประกาศ]\n"${room.title}"\nปฏิเสธโดย: ${rejecterTag}`)
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
