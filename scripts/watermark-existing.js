// scripts/watermark-existing.js — CLI wrapper around the watermark backfill.
//
//   node scripts/watermark-existing.js --dry-run   # report only, touch nothing
//   node scripts/watermark-existing.js             # rewrite in place
//   node scripts/watermark-existing.js --force     # redo after a style change
//
// Must run where the uploads volume is mounted (inside the Railway container,
// via `railway ssh`) — `railway run` executes locally and would happily report
// "0 photos" against an empty directory. Admins can run the same job from the
// admin panel instead; the logic lives in the service both call.

import { UPLOADS_DIR } from '../src/config.js'
import { runBackfill, paths } from '../src/services/watermarkBackfill.service.js'

const dryRun = process.argv.includes('--dry-run')
const force  = process.argv.includes('--force')

let lastLogged = 0
const stats = await runBackfill({
  dryRun,
  force,
  onProgress: (s) => {
    if (s.done >= lastLogged + 25) { lastLogged = s.done; console.log(`  …${s.done} watermarked`) }
  },
})

for (const f of stats.failures) console.error(`  FAILED ${f}`)

console.log(`
${dryRun ? 'DRY RUN — nothing written' : 'Done'}
  uploads dir : ${UPLOADS_DIR}
  scanned     : ${stats.seen}
  watermarked : ${stats.done}
  skipped     : ${stats.skipped}  (already archived, or too small to mark)
  failed      : ${stats.failed}
${stats.alreadyMarked ? `
  ${stats.alreadyMarked} photo(s) were marked at upload before originals were archived,
  so there is no clean copy to restyle from. Left untouched rather than
  double-marked. Re-upload these to get the current style:
${stats.alreadyMarkedFiles.map((f) => `    ${f}`).join('\n')}
` : ''}
  size        : ${(stats.bytesBefore / 1e6).toFixed(1)} MB -> ${(stats.bytesAfter / 1e6).toFixed(1)} MB
${stats.done && !dryRun ? `\n  originals kept in ${paths.originals}\n  to undo: cp -r ${paths.originals}/. ${paths.rooms}/` : ''}`)
