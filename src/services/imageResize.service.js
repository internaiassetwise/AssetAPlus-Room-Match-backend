// src/services/imageResize.service.js — Prepare uploaded room photos for the
// web before writing to disk: resize, then watermark.
//
// This is the one path both upload routes call, which is deliberate — it is
// the choke point that guarantees no photo reaches the volume unmarked.
//
// Phone cameras produce 3-10 MB JPEGs (4000+ px). Serving those on the
// landing page causes visible lag — the browser downloads and decodes
// massive images for every room card. This module shrinks uploads to a
// max width of 1200px on the longest edge, which drops file size to
// ~200-500 KB with no visible quality loss on screen.

import sharp from 'sharp'
import { applyWatermark } from './watermark.service.js'

const MAX_WIDTH  = 1200
const MAX_HEIGHT = 1200
const QUALITY    = 82   // sweet spot — visually identical, ~60% smaller than 100

/**
 * Resize to fit within MAX_WIDTH × MAX_HEIGHT (maintains aspect ratio, never
 * upscales). Output is always JPEG for consistency (PNG/WebP/GIF inputs are
 * converted). Returns the original buffer unchanged if sharp fails (e.g.
 * animated GIF, corrupt header).
 */
async function resizeOnly(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 12) return buffer
  try {
    return await sharp(buffer)
      .rotate()                     // auto-orient from EXIF (phone photos)
      .resize(MAX_WIDTH, MAX_HEIGHT, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: QUALITY, mozjpeg: true })
      .toBuffer()
  } catch {
    // sharp can't process this file — return the original so the upload
    // still succeeds (the detectImageExt check already validated it's an image).
    return buffer
  }
}

/**
 * Produce both versions of an upload:
 *   web      — resized + watermarked, what gets served
 *   pristine — resized, NO watermark, archived to uploads/originals/
 *
 * Keeping the pristine copy is what makes the watermark a reversible decision.
 * Photos uploaded before this existed were marked in place with no archive, so
 * when the mark's style changed there was no way to re-derive them — the only
 * options were to leave them on the old style or stack a second mark on top.
 * Archiving here means any future restyle is just a --force backfill.
 *
 * @param {Buffer} buffer  Raw image bytes from multer
 * @returns {Promise<{web: Buffer, pristine: Buffer}>}
 */
export async function prepareForWeb(buffer) {
  const pristine = await resizeOnly(buffer)
  // Watermark last, so the handle is sized against the dimensions we actually
  // ship rather than whatever the phone produced.
  const web = await applyWatermark(pristine)
  return { web, pristine }
}

/**
 * Back-compat shape for callers that only want the served bytes.
 * @param {Buffer} buffer
 * @returns {Promise<Buffer>} Optimized, watermarked JPEG
 */
export async function resizeForWeb(buffer) {
  const { web } = await prepareForWeb(buffer)
  return web
}
