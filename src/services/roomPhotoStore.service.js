// src/services/roomPhotoStore.service.js — write an uploaded room photo to the
// volume, in both the served and the archived form.
//
// Exists because two routes (admin upload, LIFF listing form) were each doing
// their own mkdir/writeFile, and they disagreed on where uploads live:
// process.cwd()/uploads in one, UPLOADS_DIR in the other. Those resolve to the
// same directory in the container only because cwd happens to be /app — set
// UPLOADS_DIR to anything else and half the photos would vanish from the site.

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { UPLOADS_DIR } from '../config.js'
import { prepareForWeb } from './imageResize.service.js'
import { logger } from '../logger.js'

/**
 * Save one photo. Writes the watermarked copy to rooms/<id>/ and the unmarked
 * copy to originals/rooms/<id>/ under the same name.
 *
 * The archive is best-effort: if it fails the upload still succeeds, because a
 * missing archive costs us a future restyle while a failed write costs the
 * landlord their photo.
 *
 * @param {string|number} roomId
 * @param {Buffer} buffer  Raw bytes from multer
 * @param {string} ext     Extension including the dot, from detectImageExt
 * @returns {Promise<string>} the stored file name
 */
export async function saveRoomPhoto(roomId, buffer, ext) {
  const { web, pristine } = await prepareForWeb(buffer)
  const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`

  const dir = path.join(UPLOADS_DIR, 'rooms', String(roomId))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, fileName), web)

  try {
    const archiveDir = path.join(UPLOADS_DIR, 'originals', 'rooms', String(roomId))
    await fs.mkdir(archiveDir, { recursive: true })
    await fs.writeFile(path.join(archiveDir, fileName), pristine)
  } catch (err) {
    logger.warn({ err, roomId, fileName }, 'could not archive unmarked original')
  }

  return fileName
}
