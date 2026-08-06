// src/services/watermarkBackfill.service.js — apply the current watermark to
// photos already sitting on the volume.
//
// Photos are marked when they are written, so a file keeps whatever style was
// live at upload time; changing the watermark code does not reach backwards.
// This is what reaches backwards.
//
// Every original is copied to uploads/originals/<same relative path> BEFORE it
// is overwritten. That archive does double duty: watermarking is destructive and
// otherwise unrecoverable, and its presence is also how a re-run knows a file is
// finished. So this is safe to re-run, and safe to undo by copying originals/
// back over rooms/.
//
// Driven by scripts/watermark-existing.js (CLI) and the admin endpoint.

import fs from 'node:fs/promises'
import path from 'node:path'
import { UPLOADS_DIR } from '../config.js'
import { applyWatermark } from './watermark.service.js'

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

// When watermark-on-upload went live. Uploads are named `${Date.now()}-hex.ext`,
// so the filename says when a photo arrived.
//
// This exists to catch a one-off hole: photos uploaded AFTER watermarking
// started but BEFORE uploads began archiving an unmarked original were marked in
// place with no pristine copy anywhere. Treating those as source material would
// stamp a second mark on top of the first and then save that double-marked file
// as their "original" — unrecoverable. So: no archive + arrived after this
// instant means already marked, and the only way to restyle it is to re-upload.
const WATERMARKING_LIVE_AT = Date.parse('2026-08-05T09:10:44Z')

/** Upload time from the filename, or null if it doesn't follow the convention. */
function uploadedAt(fileName) {
  const ts = Number(fileName.split('-')[0])
  return Number.isFinite(ts) && ts > 1e12 ? ts : null
}

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

async function* walk(dir) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(full)
    else if (IMAGE_EXT.has(path.extname(e.name).toLowerCase())) yield full
  }
}

export const paths = {
  rooms:     path.join(UPLOADS_DIR, 'rooms'),
  originals: path.join(UPLOADS_DIR, 'originals', 'rooms'),
}

/**
 * @param {object}   [opts]
 * @param {boolean}  [opts.dryRun]  Report only, write nothing.
 * @param {boolean}  [opts.force]   Redo finished photos (after a style change).
 *                                  Always re-derives from the archived original,
 *                                  so it cannot stack a second mark.
 * @param {Function} [opts.onProgress] Called with the running stats object.
 * @returns {Promise<object>} stats
 */
export async function runBackfill({ dryRun = false, force = false, onProgress } = {}) {
  const stats = {
    seen: 0, done: 0, skipped: 0, failed: 0,
    bytesBefore: 0, bytesAfter: 0,
    alreadyMarked: 0, alreadyMarkedFiles: [], failures: [],
  }

  for await (const file of walk(paths.rooms)) {
    stats.seen++
    const rel    = path.relative(paths.rooms, file)
    const backup = path.join(paths.originals, rel)

    const backedUp = await exists(backup)
    if (backedUp && !force) { stats.skipped++; continue }

    // No archive, but it arrived after we started marking on upload → the file
    // on disk is already marked and there is no clean copy to work from.
    const at = uploadedAt(path.basename(file))
    if (!backedUp && at && at >= WATERMARKING_LIVE_AT) {
      stats.alreadyMarked++
      stats.alreadyMarkedFiles.push(rel)
      continue
    }

    try {
      // Always mark the PRISTINE image. Reading the on-disk file under force
      // would feed an already-marked photo back through and stack a second
      // pattern on top of the first.
      const before = await fs.readFile(backedUp ? backup : file)
      const after  = await applyWatermark(before)

      // applyWatermark returns the input untouched when it bails (too small,
      // sharp error). Rewriting then would create an archive implying work was
      // done and permanently skip the file on the next run.
      if (after === before) { stats.skipped++; continue }

      stats.bytesBefore += before.length
      stats.bytesAfter  += after.length

      if (!dryRun) {
        if (!backedUp) {
          await fs.mkdir(path.dirname(backup), { recursive: true })
          await fs.writeFile(backup, before)   // archive first — never the other way round
        }
        await fs.writeFile(file, after)
      }
      stats.done++
    } catch (err) {
      stats.failed++
      stats.failures.push(`${rel}: ${err.message}`)
    }
    onProgress?.(stats)
  }

  return stats
}
