// src/routes/adminImages.js — run the watermark backfill from the admin panel.
//
//   GET  /api/admin/images/watermark        (admin) → current/last job state
//   POST /api/admin/images/watermark        (admin) → start a job
//     body: { dryRun?: boolean, force?: boolean }
//
// The job runs detached and is polled, rather than being awaited inside the
// request. A few hundred photos take longer than any sane proxy timeout, and a
// request that dies mid-way would leave the admin with no idea whether it
// finished — while the work carried on regardless.
//
// State is a single in-memory slot: one instance, one job at a time. That is
// also the concurrency guard — two overlapping runs would race on the same
// files, and the second could archive a half-written file as an "original".

import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../middleware/AppError.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { logger } from '../logger.js'
import { runBackfill } from '../services/watermarkBackfill.service.js'

export const adminImages = Router()

const startBody = z.object({
  dryRun: z.boolean().optional(),
  force:  z.boolean().optional(),
  reclaim: z.boolean().optional(),
})

/** @type {null | {running:boolean, dryRun:boolean, force:boolean, startedAt:string, finishedAt:string|null, startedBy:string|null, error:string|null, stats:object}} */
let job = null

function publicJob() {
  if (!job) return { running: false, lastRun: null }
  const { stats, ...rest } = job
  return {
    running: job.running,
    lastRun: {
      ...rest,
      scanned:            stats.seen,
      watermarked:        stats.done,
      skipped:            stats.skipped,
      failed:             stats.failed,
      alreadyMarked:      stats.alreadyMarked,
      reclaimed:          stats.reclaimed,
      urlsBumped:         stats.urlsBumped,
      alreadyMarkedFiles: stats.alreadyMarkedFiles.slice(0, 50),
      failures:           stats.failures.slice(0, 20),
    },
  }
}

adminImages.get('/watermark', requireAdmin, asyncHandler(async (_req, res) => {
  res.json(publicJob())
}))

adminImages.post('/watermark', requireAdmin, validate({ body: startBody }),
  asyncHandler(async (req, res) => {
    if (job?.running) {
      throw new AppError(409, 'ALREADY_RUNNING', 'กำลังทำลายน้ำอยู่แล้ว กรุณารอให้เสร็จก่อน')
    }

    const dryRun = Boolean(req.body?.dryRun)
    const force  = Boolean(req.body?.force)
    const reclaim = Boolean(req.body?.reclaim)

    job = {
      running: true, dryRun, force, reclaim,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      startedBy: req.admin?.displayName || req.admin?.username || null,
      error: null,
      stats: { seen: 0, done: 0, skipped: 0, failed: 0, bytesBefore: 0, bytesAfter: 0, alreadyMarked: 0, alreadyMarkedFiles: [], failures: [], reclaimed: 0, urlsBumped: 0 },
    }

    // Deliberately not awaited — the response returns now and the client polls.
    runBackfill({ dryRun, force, reclaim, onProgress: (s) => { job.stats = s } })
      .then((stats) => {
        job.stats = stats
        logger.info({ ...stats, alreadyMarkedFiles: undefined, failures: undefined }, 'watermark backfill finished')
      })
      .catch((err) => {
        job.error = err.message
        logger.error({ err }, 'watermark backfill failed')
      })
      .finally(() => {
        job.running = false
        job.finishedAt = new Date().toISOString()
      })

    res.status(202).json(publicJob())
  }),
)
