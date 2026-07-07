// src/routes/stats.js — Aggregate metrics.
import { Router } from 'express'
import * as repo from '../db/repositories/stats.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'

export const stats = Router()

stats.get('/', asyncHandler(async (_req, res) => {
  res.json(await repo.getOverview())
}))