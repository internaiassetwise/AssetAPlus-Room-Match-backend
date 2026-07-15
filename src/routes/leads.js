// src/routes/leads.js — Anonymous tenant lead capture.
//
// Public endpoint — no auth. Throttled by IP (5/min). Stores a row in
// `tenant_leads` that admin staff can act on.

import { Router } from 'express'
import { z } from 'zod'
import * as repo from '../db/repositories/leads.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { rateLimit }    from '../middleware/rateLimit.js'

export const leads = Router()

const tenantBody = z.object({
  zone:          z.string().trim().max(40).optional().or(z.literal('')),
  monthlyBudget: z.coerce.number().int().nonnegative().optional(),
  propertyType:  z.string().trim().max(40).optional().or(z.literal('')),
  moveIn:        z.string().trim().max(40).optional().or(z.literal('')),
  fullName:      z.string().trim().min(1, 'กรุณาระบุชื่อ').max(120),
  phone:         z.string().trim().min(8, 'กรุณาระบุเบอร์โทร').max(40),
})

leads.post('/tenant',
  rateLimit({ windowMs: 60 * 1000, max: 5, message: 'ส่งบ่อยเกินไป กรุณารอสักครู่' }),
  validate({ body: tenantBody }),
  asyncHandler(async (req, res) => {
    const id = await repo.createTenantLead({
      ...req.body,
      source: req.headers.referer || 'landing',
    })
    res.status(201).json({ ok: true, id })
  }),
)
