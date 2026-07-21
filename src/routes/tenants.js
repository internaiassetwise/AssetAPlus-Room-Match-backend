// src/routes/tenants.js — Admin-only tenant directory (for the matching panel).
//
//   GET /api/tenants  → list all tenants (requireAdmin)
//
// The matching endpoints (create/list/update matches) already live in
// routes/matches.js and are also admin-gated.

import { Router } from 'express'
import * as repo from '../db/repositories/tenants.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { requireAdmin } from '../middleware/requireAdmin.js'

export const tenants = Router()

tenants.use(requireAdmin)

tenants.get('/', asyncHandler(async (_req, res) => {
  res.json(await repo.findAll({ limit: 500 }))
}))
