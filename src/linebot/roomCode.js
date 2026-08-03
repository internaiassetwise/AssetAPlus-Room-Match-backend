// src/linebot/roomCode.js — Room-number masking for anything the customer sees.
//
// Room numbers identify a real unit in a real building. The website already
// hides them from the public (admin only), but LINE still needs to name a room
// so a customer can say which one they mean — so we show a partial code instead:
//
//   A01234 → A012xx      B0311 → B03xx
//
// The internal room id is what every lookup actually uses (it rides invisibly in
// the Flex postback `data`), so masking the visible label breaks nothing.
//
// Apply this at the LINE boundary AND to the tool results fed to Gemini: the
// model cannot leak a code it was never given.

/**
 * Hide the tail of a room number.
 *
 * @param {string|null|undefined} code
 * @returns {string|null} masked code, or null when there is nothing to show
 */
export function maskRoomCode(code) {
  const s = String(code ?? '').trim()
  if (!s) return null
  // 4+ chars: hide the last two, the case the user asked for (A01234 → A012xx).
  if (s.length >= 4) return `${s.slice(0, -2)}xx`
  // 3 chars: hiding two would leave a single letter — useless to the customer
  // AND no more private. Hide one.
  if (s.length === 3) return `${s.slice(0, -1)}x`
  // 1-2 chars carry no unit detail worth hiding.
  return s
}

/**
 * Mask a room's code where it appears inside free text.
 *
 * Admins routinely put the unit number in the listing title —
 * "Kave Pop Salaya - A0707" — which hands the customer the full code even
 * though the code field beside it is masked. Rewrite the title too, so masking
 * cannot be undone by the line right above it.
 *
 * @param {string|null|undefined} text
 * @param {string|null|undefined} code  The room's own code.
 */
export function maskCodeInText(text, code) {
  const t = String(text ?? '')
  const c = String(code ?? '').trim()
  if (!t || c.length < 3) return t || null
  const masked = maskRoomCode(c)
  if (!masked || masked === c) return t
  // Escape regex metacharacters — a code is admin-entered and could contain any.
  const pattern = new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  return t.replace(pattern, masked)
}
