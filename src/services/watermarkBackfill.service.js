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
import sharp from 'sharp'
import { UPLOADS_DIR } from '../config.js'
import { applyWatermark } from './watermark.service.js'
import * as roomImages from '../db/repositories/roomImages.repo.js'

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

// Geometry of the FIRST watermark style — a single mark in the bottom-right —
// so its strip can be measured and removed. These are the values that shipped
// with it, not the current ones; do not "fix" them to match watermark.service.
const LEGACY_CORNER = {
  widthRatio:  0.26,
  minWidth:    90,
  marginRatio: 0.03,
  aspect:      0.12,   // mark height ÷ width of the asset as it was then
}

/**
 * Remove the old corner mark by trimming the strip it occupied.
 *
 * This is for photos marked at upload before originals were archived: the mark
 * is in the only copy that exists, so it cannot be undone — the choice is to
 * lose the bottom edge or keep the wrong mark forever. The strip is computed
 * from the geometry above rather than being a flat percentage, so it takes the
 * least it can: ~11% of a landscape photo, ~3% of a portrait one.
 *
 * Returns null when the photo is too small to have been marked, or when the
 * strip would be big enough to ruin the photo — better to leave it alone and
 * report it than to quietly mangle it.
 */
async function stripLegacyCorner(buffer) {
  const { width, height } = await sharp(buffer).metadata()
  if (!width || !height || width < 320) return null

  const markWidth  = Math.max(LEGACY_CORNER.minWidth, Math.round(width * LEGACY_CORNER.widthRatio))
  const margin     = Math.round(width * LEGACY_CORNER.marginRatio)
  const markHeight = Math.round(markWidth * LEGACY_CORNER.aspect)
  const strip      = margin + markHeight + Math.round(height * 0.01)   // 1% safety for shadow spill

  if (strip >= height * 0.25) return null

  return await sharp(buffer)
    .extract({ left: 0, top: 0, width, height: height - strip })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer()
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
 * Point every cache at the new bytes.
 *
 * Rewriting a photo in place leaves its URL identical, and /uploads is served
 * with max-age=7d — so browsers and LINE keep showing the pre-watermark image
 * for up to a week, with no way to know it is stale. Stamping a new ?v= makes it
 * a different URL, so the next request actually fetches.
 *
 * Best-effort: the file on disk is already correct, and failing the whole job
 * over a cache hint would be worse than a slow refresh.
 */
async function bustCache(rel, token, stats) {
  const [roomId, fileName] = [rel.split(path.sep)[0], path.basename(rel)]
  try {
    if (await roomImages.bumpCacheToken(roomId, fileName, token)) stats.urlsBumped++
  } catch {
    /* cosmetic — the photo is correct either way */
  }
}

/**
 * @param {object}   [opts]
 * @param {boolean}  [opts.dryRun]  Report only, write nothing.
 * @param {boolean}  [opts.force]   Redo finished photos (after a style change).
 *                                  Always re-derives from the archived original,
 *                                  so it cannot stack a second mark.
 * @param {boolean}  [opts.reclaim] For photos marked at upload with no archived
 *                                  original: trim the old corner mark away and
 *                                  re-mark. Costs the bottom edge — the mark is
 *                                  in the only copy that exists, so there is no
 *                                  lossless option. Off by default.
 * @param {Function} [opts.onProgress] Called with the running stats object.
 * @returns {Promise<object>} stats
 */

export async function runBackfill({ dryRun = false, force = false, reclaim = false, onProgress } = {}) {
  // One token per run: same cache generation for everything this job touches.
  const token = Date.now()
  const stats = {
    seen: 0, done: 0, skipped: 0, failed: 0,
    bytesBefore: 0, bytesAfter: 0,
    alreadyMarked: 0, alreadyMarkedFiles: [], failures: [], reclaimed: 0, urlsBumped: 0,
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
    const orphan = !backedUp && at && at >= WATERMARKING_LIVE_AT

    if (orphan && !reclaim) {
      stats.alreadyMarked++
      stats.alreadyMarkedFiles.push(rel)
      continue
    }

    if (orphan) {
      // Trim the old mark away and treat the result as this photo's original,
      // so it joins the normal flow and every later restyle works from it.
      try {
        const current = await fs.readFile(file)
        const cropped = await stripLegacyCorner(current)
        if (!cropped) {
          stats.alreadyMarked++
          stats.alreadyMarkedFiles.push(rel)
          continue
        }
        if (!dryRun) {
          await fs.mkdir(path.dirname(backup), { recursive: true })
          await fs.writeFile(backup, cropped)
          await fs.writeFile(file, await applyWatermark(cropped))
          await bustCache(rel, token, stats)
        }
        stats.reclaimed++
        stats.done++
      } catch (err) {
        stats.failed++
        stats.failures.push(`${rel}: ${err.message}`)
      }
      onProgress?.(stats)
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
        await bustCache(rel, token, stats)
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
