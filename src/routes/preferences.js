// src/routes/preferences.js — Landlord + tenant "ฝากห้อง / หาห้อง" forms.
import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/preferences.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate } from '../middleware/validate.js'

export const preferences = Router()

const landlordBody = z.object({
  name:         z.string().trim().min(1, 'กรุณาระบุชื่อ').max(120),
  phone:        z.string().trim().min(8, 'กรุณาระบุเบอร์โทร').max(40),
  email:        z.string().trim().email('อีเมลไม่ถูกต้อง').max(160).optional().or(z.literal('')),
  zone:         z.string().trim().max(40).optional().or(z.literal('')),
  propertyType: z.string().trim().max(40).optional().or(z.literal('')),
  bedrooms:     z.coerce.number().int().min(0).max(10).optional(),
  note:         z.string().trim().max(1000).optional().or(z.literal('')),
})

preferences.post('/', validate({ body: landlordBody }), asyncHandler(async (req, res) => {
  const id = await repo.createLandlordPreference(req.body)
  res.status(201).json({ ok: true, id })
}))

const tenantBody = z.object({
  name:         z.string().trim().min(1, 'กรุณาระบุชื่อ').max(120),
  phone:        z.string().trim().min(8, 'กรุณาระบุเบอร์โทร').max(40),
  email:        z.string().trim().email('อีเมลไม่ถูกต้อง').max(160).optional().or(z.literal('')),
  occupation:   z.enum(['student', 'professional', 'business_owner', 'other']).optional(),
  monthlyIncome: z.coerce.number().int().nonnegative().optional(),
  moveInDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'รูปแบบวันที่ไม่ถูกต้อง (YYYY-MM-DD)').optional().or(z.literal('')),
  hasPets:      z.coerce.boolean().optional(),
  smoker:       z.coerce.boolean().optional(),
  zone:         z.string().trim().max(40).optional().or(z.literal('')),
  propertyType: z.string().trim().max(40).optional().or(z.literal('')),
  minBedrooms:  z.coerce.number().int().min(0).max(10).optional(),
  maxBedrooms:  z.coerce.number().int().min(0).max(10).optional(),
  minRent:      z.coerce.number().int().nonnegative().optional(),
  maxRent:      z.coerce.number().int().nonnegative().optional(),
  note:         z.string().trim().max(1000).optional().or(z.literal('')),
})

preferences.post('/tenant', validate({ body: tenantBody }), asyncHandler(async (req, res) => {
  const id = await repo.createTenantPreference(req.body)
  res.status(201).json({ ok: true, id })
}))