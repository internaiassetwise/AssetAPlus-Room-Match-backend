// src/services/fileSignature.service.js — Detect an image's type from its
// actual bytes, NOT the client-supplied filename or Content-Type (both are
// attacker-controlled). Used to pick a safe file extension on upload and to
// reject non-image payloads, defending against content-type confusion stored
// XSS (e.g. evil.html uploaded as image/png then served as text/html).
//
// No external dep — reads magic-byte signatures only.

const SIGNATURES = [
  // JPG: FF D8 FF
  { ext: '.jpg',  ok: (b) => b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  { ext: '.png',  ok: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A },
  // GIF: 47 49 46 38 ("GIF8")
  { ext: '.gif',  ok: (b) => b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61 },
  // WebP: "RIFF"...."WEBP"
  { ext: '.webp', ok: (b) => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
]

/**
 * Detect a supported image extension from a file's bytes.
 * @param {Buffer|null|undefined} buf
 * @returns {'.jpg'|'.png'|'.gif'|'.webp'|null} null = not a supported image
 */
export function detectImageExt(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 12) return null
  for (const sig of SIGNATURES) if (sig.ok(buf)) return sig.ext
  return null
}
