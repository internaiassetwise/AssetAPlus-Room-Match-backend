// src/services/imageResize.service.js — Resize uploaded room photos to a
// web-friendly size before writing to disk.
//
// Phone cameras produce 3-10 MB JPEGs (4000+ px). Serving those on the
// landing page causes visible lag — the browser downloads and decodes
// massive images for every room card. This module shrinks uploads to a
// max width of 1200px on the longest edge, which drops file size to
// ~200-500 KB with no visible quality loss on screen.

import sharp from 'sharp'

const MAX_WIDTH  = 1200
const MAX_HEIGHT = 1200
const QUALITY    = 82   // sweet spot — visually identical, ~60% smaller than 100

/**
 * Resize an image buffer to fit within MAX_WIDTH × MAX_HEIGHT (maintains
 * aspect ratio, never upscales). Output is always JPEG for consistency
 * (PNG/WebP/GIF inputs are converted). Returns the original buffer
 * unchanged if sharp fails (e.g., animated GIF, corrupt header).
 *
 * @param {Buffer} buffer  Raw image bytes from multer
 * @returns {Promise<Buffer>} Optimized JPEG buffer
 */
export async function resizeForWeb(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 12) return buffer
  try {
    return await sharp(buffer)
      .rotate()                     // auto-orient from EXIF (phone photos)
      .resize(MAX_WIDTH, MAX_HEIGHT, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: QUALITY, mozjpeg: true })
      .toBuffer()
  } catch (err) {
    // sharp can't process this file — return the original so the upload
    // still succeeds (the detectImageExt check already validated it's an image).
    return buffer
  }
}
