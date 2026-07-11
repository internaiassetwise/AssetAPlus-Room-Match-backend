// src/routes/contact.js — Quick contact form.
import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/contact.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate } from '../middleware/validate.js'
import { rateLimit } from '../middleware/rateLimit.js'

export const contact = Router()

const body = z.object({
  name:    z.string().trim().min(1, 'กรุณาระบุชื่อ').max(120),
  phone:   z.string().trim().min(8, 'กรุณาระบุเบอร์โทร').max(40),
  email:   z.string().trim().email('อีเมลไม่ถูกต้อง').max(160).optional().or(z.literal('')),
  message: z.string().trim().max(2000).optional().or(z.literal('')),
})

contact.post('/',
  rateLimit({ windowMs: 60 * 1000, max: 5, message: 'ส่งข้อความบ่อยเกินไป กรุณารอสักครู่' }),
  validate({ body }), asyncHandler(async (req, res) => {
  const id = await repo.create({ ...req.body, source: req.headers.referer || 'unknown' })
  res.status(201).json({ ok: true, id })
}))