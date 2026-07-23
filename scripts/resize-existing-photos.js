// scripts/resize-existing-photos.js — One-time batch resize of all existing
// room photos in uploads/rooms/ to the web-optimized format (1200px max,
// JPEG q82). Run once after deploying the sharp resize-on-upload change.
//
// Usage:
//   node scripts/resize-existing-photos.js          # dry-run (prints what it would do)
//   node scripts/resize-existing-photos.js --apply   # actually resize
//
// Idempotent: skips files already under 500 KB (already optimized).

import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from '../src/services/imageResize.service.js'

const UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'rooms')
const SKIP_THRESHOLD = 500 * 1024  // 500 KB — already small enough
const apply = process.argv.includes('--apply')

async function walkDir(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return // dir doesn't exist yet
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkDir(fullPath)
    } else if (/\.(jpg|jpeg|png|webp|gif)$/i.test(entry.name)) {
      await processFile(fullPath)
    }
  }
}

async function processFile(filePath) {
  const stat = await fs.stat(filePath)
  if (stat.size < SKIP_THRESHOLD) {
    console.log(`  ⏭  ${path.relative(process.cwd(), filePath)} (${(stat.size / 1024).toFixed(0)} KB) — already small, skip`)
    return
  }

  const buffer = await fs.readFile(filePath)
  const optimized = await sharp.resizeForWeb(buffer)

  const beforeKB = (stat.size / 1024).toFixed(0)
  const afterKB = (optimized.length / 1024).toFixed(0)
  const pct = ((1 - optimized.length / stat.size) * 100).toFixed(0)

  if (apply) {
    // Write the optimized buffer, then rename to .jpg if the original was
    // png/webp/gif (sharp always outputs JPEG). We keep the same base name
    // so room_images.url stays valid — just update the extension.
    const ext = path.extname(filePath)
    const newPath = ext.toLowerCase() === '.jpg' || ext.toLowerCase() === '.jpeg'
      ? filePath
      : filePath.replace(/\.(png|webp|gif)$/i, '.jpg')

    await fs.writeFile(newPath, optimized)
    if (newPath !== filePath) {
      await fs.unlink(filePath)
      console.log(`  ✅  ${path.relative(process.cwd(), filePath)} → ${path.basename(newPath)}  ${beforeKB} KB → ${afterKB} KB (-${pct}%)`)
    } else {
      console.log(`  ✅  ${path.relative(process.cwd(), filePath)}  ${beforeKB} KB → ${afterKB} KB (-${pct}%)`)
    }
  } else {
    console.log(`  🔍  ${path.relative(process.cwd(), filePath)}  ${beforeKB} KB → ${afterKB} KB (-${pct}%) [dry-run]`)
  }
}

console.log(apply ? '⚡ Resizing existing photos...\n' : '🔍 Dry run (add --apply to resize)...\n')

if (!await fs.access(UPLOADS_DIR).then(() => true).catch(() => false)) {
  console.log('No uploads/rooms directory found — nothing to resize.')
  process.exit(0)
}

await walkDir(UPLOADS_DIR)

console.log(apply ? '\n✅ Done.' : '\nRun with --apply to resize for real.')
