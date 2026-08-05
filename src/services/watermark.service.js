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
// TILED diagonally across the frame rather than sat in one corner. A corner mark
// is one crop away from gone, which defeats the point. Tiling costs some of the
// photo's clarity, so the alpha is kept low enough to read the room through it —
// the mark only has to be legible in a screenshot, not dominant.
//
// The mark itself is a pre-rendered PNG (see scripts/build-watermark.js) —
// runtime text rendering would need fonts we can't count on in the container.

import sharp from 'sharp'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../logger.js'

const MARK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'watermark.png')

const ANGLE       = -30    // degrees; diagonal reads as a watermark, not as a caption
const WIDTH_RATIO = 0.16   // one mark spans ~16% of the photo width
const OPACITY     = 0.22   // visible in a screenshot, still see-through
// Tile pitch, in multiples of the rotated mark. Must stay >= 2: the staggered
// copy sits at half the tile, so anything tighter pushes it past the canvas edge
// and sharp throws. Denser coverage comes from a smaller WIDTH_RATIO instead.
const GAP_X       = 2.1
const GAP_Y       = 2.3

// Below this a tiled pattern is just noise over something too small to steal.
const MIN_PHOTO_WIDTH = 320

// Building a tile means rotate + composite + alpha-scale, so it is cached per
// photo width. Uploads are all capped to 1200px, so this is near-always a hit.
const tileCache = new Map()

/**
 * A transparent tile carrying two offset copies of the mark, so tiling produces
 * a staggered brick layout instead of a rigid grid (rigid grids read as a
 * texture and are easier to inpaint out).
 */
async function buildTile(photoWidth) {
  const cached = tileCache.get(photoWidth)
  if (cached) return cached

  const markWidth = Math.round(photoWidth * WIDTH_RATIO)
  const rotated = await sharp(MARK_PATH)
    .resize({ width: markWidth })
    .rotate(ANGLE, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  const rot = await sharp(rotated).metadata()

  const tileW = Math.round(rot.width * GAP_X)
  const tileH = Math.round(rot.height * GAP_Y)

  const tile = await sharp({
    create: { width: tileW, height: tileH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: rotated, top: 0, left: 0 },
      // Half-pitch offset — the stagger. GAP_* are >2 so this copy still fits.
      { input: rotated, top: Math.round(tileH / 2), left: Math.round(tileW / 2) },
    ])
    .png()
    .toBuffer()

  // Scale the alpha down. `dest-in` multiplies the tile's alpha by the source's,
  // so a flat translucent layer dims the whole thing uniformly — this is why the
  // asset is stored at full opacity and toned here.
  const faded = await sharp(tile)
    .composite([{
      input: Buffer.from([255, 255, 255, Math.round(255 * OPACITY)]),
      raw: { width: 1, height: 1, channels: 4 },
      tile: true,
      blend: 'dest-in',
    }])
    .png()
    .toBuffer()

  tileCache.set(photoWidth, faded)
  return faded
}

/**
 * Tile the handle across the photo.
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

    const tile = await buildTile(width)

    return await sharp(buffer)
      .composite([{ input: tile, tile: true, blend: 'over' }])
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer()
  } catch (err) {
    logger.warn({ err }, 'watermark failed — storing photo unmarked')
    return buffer
  }
}
