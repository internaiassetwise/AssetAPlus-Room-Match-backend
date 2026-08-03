// src/services/roomRef.js — a short, signed "which room" tag for chat messages.
//
// When a customer taps "สอบถามห้องนี้" on a room page, LINE opens with the
// question already typed. The message then arrives at our webhook as ordinary
// text with nothing tying it to the room they were reading — so admin had to
// ask, and the bot answered generically.
//
// The pre-filled text carries a tag like `RM-AK-7C4F2B`. It is signed, so a
// guessed or edited tag resolves to nothing rather than to someone else's room,
// and it is short enough not to dominate a chat bubble. The webhook strips it
// before the bot sees the text, so the conversation still reads naturally.
//
// The room id is inside the tag in plain base36. That is deliberate: the id
// already appears in the public room URL (/rooms/386) and in Flex postback
// data. What we hide from customers is the UNIT number (room_code) — a
// real-world address — and that is not in here.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

const PREFIX = 'RM'
const SIG_LEN = 6   // 6 base32 chars ≈ 30 bits — ample against guessing at
                    // human typing speed, and this grants no privileges anyway.

// Matches the tag anywhere in a message, so it still resolves when the customer
// types in front of it or LINE reflows the text.
export const ROOM_REF_RE = /RM-([0-9A-Z]+)-([0-9A-F]{6})/i

function key() {
  const k = config.OAUTH_STATE_SECRET || config.LINE_LOGIN_CHANNEL_SECRET || config.LINE_CHANNEL_SECRET
  if (!k) throw new Error('roomRef needs OAUTH_STATE_SECRET or a LINE channel secret to sign with')
  return k
}

function sign(idPart) {
  return createHmac('sha256', key()).update(`room:${idPart}`).digest('hex').slice(0, SIG_LEN).toUpperCase()
}

/** Build the tag for a room id. */
export function makeRoomRef(roomId) {
  const idPart = Number(roomId).toString(36).toUpperCase()
  return `${PREFIX}-${idPart}-${sign(idPart)}`
}

/**
 * Pull a room id out of a message, or null.
 *
 * Returns null for a missing, malformed, or badly-signed tag — the caller
 * treats all three the same way: an ordinary message with no room attached.
 */
export function parseRoomRef(text) {
  const m = ROOM_REF_RE.exec(String(text ?? ''))
  if (!m) return null
  const idPart = m[1].toUpperCase()
  const given = Buffer.from(m[2].toUpperCase())
  const want = Buffer.from(sign(idPart))
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null
  const id = parseInt(idPart, 36)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** Remove the tag (and the tidy-up whitespace around it) from a message. */
export function stripRoomRef(text) {
  return String(text ?? '')
    .replace(new RegExp(`\\s*\\(?${ROOM_REF_RE.source}\\)?\\s*`, 'i'), ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
