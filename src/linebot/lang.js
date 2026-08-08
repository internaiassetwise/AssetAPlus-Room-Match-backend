// src/linebot/lang.js — which language to speak to a LINE user in.
//
// The model already answers in whatever language it was written to (rule 1 of
// the system prompt). Flex cards do not: they are built here in code and never
// pass through the model, so an English speaker got a fluent English reply
// followed by a room card reading "ห้องนอน / ตร.ม. / อยากนัดชม".
//
// Detection is deliberately crude — Thai script or not. Thai has its own
// codepoint block, so "is there Thai in this message" is a reliable signal and
// needs no library or model call. Anything else is treated as English, which is
// the right default: the alternative for a Vietnamese or Japanese speaker is
// Thai, and English is far likelier to be their second language.

const THAI = /[฀-๿]/

/**
 * @param {string} text  what the user just typed
 * @returns {'th'|'en'}
 */
export function detectLang(text) {
  const s = String(text || '')
  if (!s.trim()) return 'th'          // nothing to go on — stay on the default
  return THAI.test(s) ? 'th' : 'en'
}

// A message only decides the language if it carries enough signal. Thai script
// is decisive immediately; Latin needs a few letters, because "ok", "no" and
// "hi" are everyday words inside Thai conversations and must not flip one.
const MIN_LATIN_LETTERS = 4

function decisive(text) {
  const s = String(text || '')
  if (THAI.test(s)) return 'th'
  const latin = (s.match(/[A-Za-z]/g) || []).length
  return latin >= MIN_LATIN_LETTERS ? 'en' : null
}

/**
 * Language for a whole conversation, given the user's recent messages.
 *
 * Uses the latest message that actually contains letters. A bare "ok" or an
 * emoji shouldn't flip a Thai conversation into English, and a stray sticker
 * shouldn't either — but a genuine switch mid-chat should be honoured, because
 * a user who starts typing English has told you what they want.
 *
 * @param {Array<{role?: string, text?: string}>} history  oldest → newest
 * @param {string} [latest]  the message being handled right now
 * @returns {'th'|'en'}
 */
export function conversationLang(history = [], latest = '') {
  const candidates = [latest, ...[...history].reverse().map((h) => h?.text)]
  for (const t of candidates) {
    const hit = decisive(t)
    if (hit) return hit
  }
  return 'th'
}
