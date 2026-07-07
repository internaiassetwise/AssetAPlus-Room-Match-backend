// src/routes/zones.js — Active zones.
import { Router } from 'express'
import * as repo from '../db/repositories/zones.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'

export const zones = Router()

zones.get('/', asyncHandler(async (_req, res) => {
  res.json(await repo.listActive())
}))