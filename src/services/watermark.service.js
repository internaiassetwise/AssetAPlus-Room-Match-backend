// src/services/watermark.service.js — stamp "@aswroommatch" into room photos.
//
// Burned into the pixels, not overlaid in CSS. A CSS overlay is decoration:
// anyone can right-click the <img>, open /uploads/... directly, and get a clean
// file. Since the point is to make a copied photo traceable back to us, the mark
// has to survive being saved, re-hosted and re-posted — so it goes in the bytes.
//
// Applied at upload, which means it reaches every consumer of a photo at once:
// the web app, the LINE Flex carousels, and anything shared onward from either.
//
// The mark itself is a pre-rendered PNG (see scripts/build-watermark.js) —
// runtime text rendering would need fonts we can't count on in the container.

import sharp from 'sharp'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../logger.js'

const MARK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'watermark.png')

// Share of the photo's width the mark spans. ~26% reads clearly on a phone
// without covering the room — the thing people are actually here to look at.
const WIDTH_RATIO = 0.26
const MIN_WIDTH   = 90     // below this the handle is an illegible smudge
const MARGIN_RATIO = 0.03

// Photos smaller than this are thumbnails/avatars — marking them just defaces
// them, and they're too small to be worth stealing.
const MIN_PHOTO_WIDTH = 320

// The resized mark is reused across uploads of the same width, which is the
// common case (everything is capped to 1200px wide).
const cache = new Map()

async function markAtWidth(width) {
  if (cache.has(width)) return cache.get(width)
  const buf = await sharp(MARK_PATH).resize({ width }).png().toBuffer()
  const { height } = await sharp(buf).metadata()
  const entry = { buf, height }
  cache.set(width, entry)
  return entry
}

/**
 * Composite the handle into the bottom-right corner.
 *
 * Returns the input unchanged on any failure. A watermark is worth less than an
 * upload: if sharp chokes on this particular file, the landlord should still get
 * their photo saved rather than a failed submission they can't diagnose.
 *
 * @param {Buffer} buffer  Image bytes (already resized)
 * @returns {Promise<Buffer>}
 */
export async function applyWatermark(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 12) return buffer
  try {
    const { width, height } = await sharp(buffer).metadata()
    if (!width || !height || width < MIN_PHOTO_WIDTH) return buffer

    const markWidth = Math.max(MIN_WIDTH, Math.round(width * WIDTH_RATIO))
    const margin    = Math.round(width * MARGIN_RATIO)
    const mark      = await markAtWidth(markWidth)

    // Guard against a mark that can't fit (very wide-but-short panoramas):
    // compositing outside the canvas throws and would cost us the upload.
    if (markWidth + margin * 2 > width || mark.height + margin * 2 > height) return buffer

    return await sharp(buffer)
      .composite([{
        input: mark.buf,
        top:  height - mark.height - margin,
        left: width - markWidth - margin,
      }])
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer()
  } catch (err) {
    logger.warn({ err }, 'watermark failed — storing photo unmarked')
    return buffer
  }
}
