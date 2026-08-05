// scripts/build-watermark.js — regenerate src/assets/watermark.png.
//
// Run this ONLY when the handle or the mark's styling changes:
//   node scripts/build-watermark.js
//
// The mark is committed as a PNG rather than drawn at runtime on purpose.
// Rendering SVG <text> needs fontconfig + a real font file inside the
// container; the Railway image is not guaranteed to ship either, and the
// failure mode is silent — sharp happily composites an empty layer, so every
// photo would go out unmarked with nothing in the logs. A PNG needs no fonts.
//
// Rendered oversized (1600px) so downscaling to any photo width stays crisp.

import sharp from 'sharp'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HANDLE = '@aswroommatch'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'watermark.png')

// White text with a soft dark shadow: the shadow is what keeps it legible on
// pale photos (white walls, bright windows), which is most listing shots.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="300">
  <defs>
    <filter id="sh" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="4" stdDeviation="9" flood-color="#000" flood-opacity="0.6"/>
    </filter>
  </defs>
  <text x="800" y="200"
        text-anchor="middle"
        font-family="Helvetica, Arial, 'DejaVu Sans', sans-serif"
        font-size="140" font-weight="700" letter-spacing="2"
        fill="#ffffff" fill-opacity="0.92"
        filter="url(#sh)">${HANDLE}</text>
</svg>`

const buf = await sharp(Buffer.from(svg)).png().toBuffer()

// Trim the transparent margin so the composite maths works off the ink itself,
// not off whatever canvas size this script happened to use.
const out = await sharp(buf).trim({ threshold: 1 }).png({ compressionLevel: 9 }).toBuffer()
const meta = await sharp(out).metadata()

if (!meta.width || meta.width < 100) {
  throw new Error(`watermark render looks empty (${meta.width}x${meta.height}) — is a font available?`)
}

await sharp(out).toFile(OUT)
console.log(`wrote ${OUT} — ${meta.width}x${meta.height}, ${out.length} bytes`)
