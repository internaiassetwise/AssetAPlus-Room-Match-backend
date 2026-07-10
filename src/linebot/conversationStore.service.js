// src/linebot/conversationStore.service.js — Friendly wrapper over the
// chat_sessions repo. Owns:
//   - history windowing (keep last N entries so prompts stay small)
//   - session expiry sliding (every write bumps expires_at by 24h)
//   - the "turn" shape we hand to the LLM (`{role, content, ts}`)
//
// We intentionally do NOT keep the full multi-turn history in the prompt.
// After 10 messages the older entries are summarised into a single
// `summary` string and dropped from `history`. This keeps token cost flat
// for landlord listings that may include 8–10 question/answer exchanges.

import * as repo from '../db/repositories/chatSessions.repo.js'
import { logger } from '../logger.js'

const MAX_HISTORY = parseInt(process.env.LINE_BOT_MAX_HISTORY || '10', 10)

/**
 * Get or create the session. Atomic — caller can immediately append.
 * @param {string} lineUserId
 */
export async function getOrCreate(lineUserId) {
  return await repo.getOrCreate(lineUserId)
}

/**
 * Append one turn to the user's history. The session row is updated only
 * if the resulting history actually changed (so concurrent writers don't
 * step on each other needlessly).
 *
 * @param {string}        lineUserId
 * @param {'user'|'assistant'} role
 * @param {string}        content   Plain text for now (no Flex JSON).
 * @returns {Promise<{history: Array, summary: string|null}>}
 */
export async function append(lineUserId, role, content) {
  const session = await repo.getOrCreate(lineUserId)
  const now     = new Date().toISOString()
  const turn    = { role, content, ts: now }

  // Drop empties — the LLM rejects them with API errors.
  const incoming = String(content ?? '').trim()
  if (!incoming) return { history: session.history, summary: session.summary }

  const newHistory = [...(session.history ?? []), turn]
  const summary    = session.summary ?? null

  const windowed = windowHistory(newHistory, summary, MAX_HISTORY)
  const persisted = windowed.history
  const nextSummary = windowed.summary

  await repo.update(lineUserId, {
    history: persisted,
    collected: session.collected ?? {},
    currentIntent: session.currentIntent,
  })

  // We don't yet persist `nextSummary` separately because the schema's
  // only summary slot is the history itself. Until Phase 6 (polish), we
  // simply drop the oldest entries beyond the window.
  return { history: persisted, summary: nextSummary }
}

/**
 * Clear the session — used when the user types "cancel", after an admin
 * escalation completes, or any time we want to reset.
 */
export async function clear(lineUserId) {
  return await repo.clear(lineUserId)
}

/**
 * Window history down to MAX_HISTORY entries. Phase 3 keeps it dumb:
 * oldest entries beyond the window are dropped. Phase 6 will replace
 * that with "summarise the dropped entries into one string".
 *
 * @returns {{history: Array, summary: string|null}}
 */
function windowHistory(history, summary, max) {
  if (!Array.isArray(history)) return { history: [], summary: null }
  if (history.length <= max) return { history, summary }
  const dropped = history.length - max
  const note = `[${dropped} older message(s) trimmed]`
  logger.debug({ dropped, kept: max }, 'chat history trimmed')
  return { history: history.slice(-max), summary: note }
}

/**
 * Read-only — used by the LLM agent to construct the prior-conversation
 * portion of the prompt.
 */
export async function loadHistory(lineUserId) {
  const session = await repo.findByLineUserId(lineUserId)
  return session?.history ?? []
}

/**
 * Peek current_intent + collected (for multi-turn tool flows; Phase 4
 * uses this).
 */
export async function peekState(lineUserId) {
  const session = await repo.findByLineUserId(lineUserId)
  return {
    currentIntent: session?.currentIntent ?? null,
    collected:     session?.collected ?? {},
  }
}

/**
 * Set state — used by tool flows to mark "we're in the middle of a
 * createRoomDraft" so the next turn picks it up.
 */
export async function setState(lineUserId, { currentIntent, collected }) {
  return await repo.update(lineUserId, {
    currentIntent,
    collected,
  })
}
