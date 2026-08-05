// scripts/watermark-existing.js — stamp the handle into photos that were
// uploaded before watermarking existed.
//
//   node scripts/watermark-existing.js --dry-run   # report only, touch nothing
//   node scripts/watermark-existing.js             # rewrite in place
//
// Must run where the uploads volume is mounted (inside the Railway container,
// via `railway ssh`) — `railway run` executes locally and would happily report
// "0 photos" against an empty directory.
//
// Every original is copied to uploads/originals/<same relative path> BEFORE it
// is overwritten. That backup does double duty: watermarking is destructive and
// otherwise unrecoverable, and its presence is also how a second run knows to
// skip a file. So this is safe to re-run, and safe to undo by copying
// originals/ back over rooms/.

import fs from 'node:fs/promises'
import path from 'node:path'
import { UPLOADS_DIR } from '../src/config.js'
import { applyWatermark } from '../src/services/watermark.service.js'

const DRY = process.argv.includes('--dry-run')

const ROOMS     = path.join(UPLOADS_DIR, 'rooms')
const ORIGINALS = path.join(UPLOADS_DIR, 'originals', 'rooms')
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

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

const stats = { seen: 0, done: 0, skipped: 0, failed: 0, bytesBefore: 0, bytesAfter: 0 }

for await (const file of walk(ROOMS)) {
  stats.seen++
  const rel    = path.relative(ROOMS, file)
  const backup = path.join(ORIGINALS, rel)

  if (await exists(backup)) { stats.skipped++; continue }

  try {
    const before = await fs.readFile(file)
    const after  = await applyWatermark(before)

    // applyWatermark returns the input untouched when it bails (too small,
    // sharp error). Rewriting then would create a backup implying work was
    // done and permanently skip the file on the next run.
    if (after === before) { stats.skipped++; continue }

    stats.bytesBefore += before.length
    stats.bytesAfter  += after.length

    if (!DRY) {
      await fs.mkdir(path.dirname(backup), { recursive: true })
      await fs.writeFile(backup, before)   // backup first — never the other way round
      await fs.writeFile(file, after)
    }
    stats.done++
    if (stats.done % 25 === 0) console.log(`  …${stats.done} watermarked`)
  } catch (err) {
    stats.failed++
    console.error(`  FAILED ${rel}: ${err.message}`)
  }
}

console.log(`
${DRY ? 'DRY RUN — nothing written' : 'Done'}
  uploads dir : ${UPLOADS_DIR}
  scanned     : ${stats.seen}
  watermarked : ${stats.done}
  skipped     : ${stats.skipped}  (already backed up, or too small to mark)
  failed      : ${stats.failed}
  size        : ${(stats.bytesBefore / 1e6).toFixed(1)} MB -> ${(stats.bytesAfter / 1e6).toFixed(1)} MB
${stats.done && !DRY ? `\n  originals kept in ${ORIGINALS}\n  to undo: cp -r ${ORIGINALS}/. ${ROOMS}/` : ''}`)
