// src/routes/my-listings.js — Landlord's own room inventory.
//
//   GET    /api/my-listings       — list
//   GET    /api/my-listings/:id   — single
//   POST   /api/my-listings       — DISABLED for human users (returns 403 CONTACT_ADMIN).
//                                  Enabled when X-Bot-Secret is valid: the Line bot
//                                  posts the room from a landlord's chat.
//   PATCH  /api/my-listings/:id   — update own rooms; `description` is admin-only (stripped)
//   DELETE /api/my-listings/:id   — delete (only own rooms)
//   POST   /api/my-listings/:id/photos — admin/bot-only photo upload
//
// Mirrors the admin rooms CRUD but uses requireLandlord + landlord_id scoping.
// Under the middleman workflow landlords do not self-list rooms and do not edit
// the room description themselves; admin handles both via the Line chatbot.

import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import * as repo from '../db/repositories/rooms.repo.js'
import * as landlordRepo from '../db/repositories/landlords.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { requireBot }   from '../middleware/requireBot.js'
import { AppError }     from '../middleware/AppError.js'
import { requireLandlord } from '../auth/middleware.js'

export const myListings = Router()

// multer in-memory so the handler can hash + decide on its own path.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },   // 10 MB cap
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new AppError(400, 'BAD_MIME', 'ต้องเป็นไฟล์รูปภาพ'))
    }
    cb(null, true)
  },
})

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

// Landlords contact admin via Line to list rooms. The endpoint stays mounted
// so a stale frontend tab that still calls it gets a clear 403 instead of a
// 404 (which would suggest "wrong URL").
//
// Bot bypass: when the request carries X-Bot-Secret (and X-Bot-LandlordLineUserId
// identifying the landlord by their lineUserId), we look up / create the
// landlord row and insert the room on their behalf.
myListings.post('/', asyncHandler(async (req, res) => {
  const botSecret = req.headers['x-bot-secret']
  const isBot = !!botSecret

  if (!isBot) {
    // Real user flow — must be signed-in landlord.
    await new Promise((resolve, reject) =>
      requireLandlord(req, res, (err) => err ? reject(err) : resolve()))
    throw new AppError(
      403,
      'CONTACT_ADMIN',
      'การลงประกาศห้องต้องทำผ่านแอดมินทาง Line เท่านั้น',
    )
  }

  // Bot flow
  await new Promise((resolve, reject) =>
    requireBot(req, res, (err) => err ? reject(err) : resolve()))

  // Validate body manually (the bot might send zone string, not zone_id)
  const writeBody = z.object({
    zoneId:        z.coerce.number().int().positive().optional(),
    zone:          z.string().trim().min(1).max(80).optional(),
    title:         z.string().trim().min(2).max(200),
    description:   z.string().max(5000).optional().or(z.literal('')),
    propertyType:  z.enum(['condo', 'house', 'townhouse', 'apartment', 'studio']).default('condo'),
    bedrooms:      z.coerce.number().int().min(0).max(10),
    bathrooms:     z.coerce.number().int().min(0).max(10),
    sizeSqm:       z.coerce.number().min(0).max(2000).optional(),
    monthlyRent:   z.coerce.number().int().min(1000).max(1_000_000),
    status:        z.enum(['available', 'reserved', 'matched', 'inactive']).optional(),
    availableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
    amenities:     z.array(z.string().trim().min(1)).max(50).optional(),
    isFeatured:    z.boolean().optional(),
    lat:           z.coerce.number().min(-90).max(90).optional(),
    lng:           z.coerce.number().min(-180).max(180).optional(),
    address:       z.string().trim().max(300).optional().or(z.literal('')),
  })
  const parsed = writeBody.parse(req.body)

  // Resolve landlord: find by line_id, else create a stub landlord we can
  // attach rooms to (admin will fill in name/phone later).
  const lineUserId = req.bot?.landlordLineUserId
  if (!lineUserId) {
    throw new AppError(400, 'BOT_NO_LANDLORD',
      'X-Bot-LandlordLineUserId header is required for bot POST /my-listings')
  }
  let landlord = await landlordRepo.findByLineId(lineUserId)
  if (!landlord) {
    landlord = await landlordRepo.createFromBot(lineUserId)
  }

  // Resolve zone: either by id or by slug/name match.
  let zoneId = parsed.zoneId
  if (!zoneId && parsed.zone) {
    const zRepo = await import('../db/repositories/zones.repo.js')
    const zones = await zRepo.findAll({ isActive: true })
    const match = zones.find(z =>
      z.slug === parsed.zone.toLowerCase() ||
      z.name_th === parsed.zone ||
      z.name_en?.toLowerCase() === parsed.zone.toLowerCase())
    if (!match) {
      throw new AppError(400, 'ZONE_NOT_FOUND',
        `ไม่รู้จักย่าน "${parsed.zone}" — ตอนนี้รองรับ: ${zones.map(z => z.name_th).slice(0, 8).join(', ')}…`)
    }
    zoneId = match.id
  }
  if (!zoneId) throw new AppError(400, 'ZONE_REQUIRED', 'กรุณาระบุ zoneId หรือ zone')

  const created = await repo.createForLandlord({
    landlordId:    landlord.id,
    zoneId,
    title:         parsed.title,
    description:   parsed.description ?? '',
    propertyType:  parsed.propertyType,
    bedrooms:      parsed.bedrooms,
    bathrooms:     parsed.bathrooms,
    sizeSqm:       parsed.sizeSqm ?? 0,
    monthlyRent:   parsed.monthlyRent,
    status:        parsed.status ?? 'available',
    availableFrom: parsed.availableFrom || null,
    amenities:     parsed.amenities ?? [],
    isFeatured:    parsed.isFeatured ?? false,
    lat:           parsed.lat ?? null,
    lng:           parsed.lng ?? null,
    address:       parsed.address ?? null,
  })

  res.status(201).json(created)
}))

/**
 * POST /:id/photos — admin/bot photo upload.
 *
 * Used by the Line bot to attach a photo the landlord sent via chat.
 * Multipart/form-data with `photo` field. Saves to /uploads/rooms/{id}/
 * and writes a room_images row. Returns the public URL of the uploaded file.
 *
 * Authentication: requireBot only. No landlord cookie — bot identifies the
 * landlord via X-Bot-LandlordLineUserId and we trust the bot to forward
 * photos for rooms the landlord owns.
 */
myListings.post('/:id/photos', requireBot, photoUpload.single('photo'),
  asyncHandler(async (req, res) => {
    const roomId = Number(req.params.id)
    if (!Number.isInteger(roomId) || roomId <= 0) {
      throw new AppError(400, 'BAD_ROOM_ID', 'ระบุ roomId ไม่ถูกต้อง')
    }
    const room = await repo.findById(roomId)
    if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'ไม่พบห้องนี้')

    if (!req.file) {
      throw new AppError(400, 'NO_FILE', 'กรุณาส่งไฟล์รูปภาพ (field: photo)')
    }

    // Save file under uploads/rooms/{roomId}/<timestamp>-<rand>.<ext>
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const crypto = await import('node:crypto')

    const ext = path.extname(req.file.originalname || '') ||
                (req.file.mimetype?.startsWith('image/png')  ? '.png' :
                 req.file.mimetype?.startsWith('image/webp') ? '.webp' :
                 req.file.mimetype?.startsWith('image/gif')  ? '.gif' : '.jpg')
    const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`
    const dir = path.join(process.cwd(), 'uploads', 'rooms', String(roomId))
    await fs.mkdir(dir, { recursive: true })
    const fullPath = path.join(dir, fileName)
    await fs.writeFile(fullPath, req.file.buffer)

    // Public URL the Line bot will use as the image src in subsequent replies.
    // Prefer the configured public origin (reliable behind a proxy); the
    // req.protocol fallback is correct now that `trust proxy` is set.
    const origin = (process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')
    const publicUrl = `${origin}/uploads/rooms/${roomId}/${fileName}`

    // Persist via a repo function (created on demand below).
    const roomImagesRepo = await import('../db/repositories/roomImages.repo.js')
    const row = await roomImagesRepo.create(roomId, publicUrl, fileName)
    return res.status(201).json({ url: publicUrl, id: row.id })
  }),
)

myListings.patch('/:id', requireLandlord,
  validate({ params: idParam, body: writeBody.partial() }),
  asyncHandler(async (req, res) => {
    // Description is admin-only — silently strip it from the payload so the
    // rest of the landlord's edits still go through. Set a response header
    // so the frontend (if it ever needs to detect this) can show a notice.
    const { description: _ignored, ...rest } = req.body
    if ('description' in req.body) {
      res.setHeader('X-Description-Admin-Only', 'true')
    }
    const updated = await repo.updateForLandlord(req.params.id, req.landlord.id, rest)
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