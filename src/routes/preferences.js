// src/routes/preferences.js — Landlord + tenant "ฝากห้อง / หาห้อง" forms.
//
// Landlord tab stays anonymous (no sign-in required).
// Tenant tab is gated by requireUser — Google sign-in must have created the
// tenant row first. Name/email come from the session; the body only carries
// mutable profile fields + the preference payload.

import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/preferences.repo.js'
import * as tenants from '../db/repositories/tenants.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { requireUser }  from '../auth/middleware.js'

export const preferences = Router()

// ─── Landlord (anonymous) ───────────────────────────────────────────────

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

// ─── Tenant (auth-gated) ─────────────────────────────────────────────────
//
// Phone + name + email come from the session, but we let the user override
// them on the form before submitting (auto-fill, not auto-lock). All other
// fields are still typed in.

const tenantBody = z.object({
  // Profile (optional overrides — `undefined` keeps the existing value)
  fullName:      z.string().trim().min(1).max(120).optional(),
  phone:         z.string().trim().min(8, 'กรุณาระบุเบอร์โทร').max(40),
  email:         z.string().trim().email('อีเมลไม่ถูกต้อง').max(160).optional().or(z.literal('')),
  occupation:    z.enum(['student', 'professional', 'business_owner', 'other']).optional(),
  monthlyIncome: z.coerce.number().int().nonnegative().optional(),
  moveInDate:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'รูปแบบวันที่ไม่ถูกต้อง (YYYY-MM-DD)').optional().or(z.literal('')),
  hasPets:       z.coerce.boolean().optional(),
  smoker:        z.coerce.boolean().optional(),
  // Preferences
  zone:         z.string().trim().max(40).optional().or(z.literal('')),
  propertyType: z.string().trim().max(40).optional().or(z.literal('')),
  minBedrooms:  z.coerce.number().int().min(0).max(10).optional(),
  maxBedrooms:  z.coerce.number().int().min(0).max(10).optional(),
  minRent:      z.coerce.number().int().nonnegative().optional(),
  maxRent:      z.coerce.number().int().nonnegative().optional(),
  note:         z.string().trim().max(1000).optional().or(z.literal('')),
})

preferences.post('/tenant', requireUser, validate({ body: tenantBody }), asyncHandler(async (req, res) => {
  const tenantId = req.user.id
  // 1. Update mutable profile fields on the existing tenant row.
  await tenants.updateTenantProfile(tenantId, req.body)
  // 2. Insert the preferences row (separate table).
  const preferenceId = await repo.createPreferenceForTenant(tenantId, req.body)
  res.status(201).json({ ok: true, id: preferenceId })
}))