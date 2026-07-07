// src/routes/health.js — Liveness + DB ping.
import { Router } from 'express'
import { ping } from '../db/pool.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'

export const health = Router()

health.get('/', asyncHandler(async (_req, res) => {
  let db = 'down'
  try { db = (await ping()) ? 'up' : 'down' } catch { /* leave as down */ }
  res.json({ ok: true, service: 'room-match', ts: Date.now(), db })
}))