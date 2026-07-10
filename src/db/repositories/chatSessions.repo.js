// src/db/repositories/chatSessions.repo.js — CRUD on the chat_sessions table.
//
// chat_sessions is the new home for "where we left off in this Line
// conversation". Each Line user has at most one open row (UNIQUE on
// line_user_id). The conversationStore.service layer is responsible for
// pruning the `history` JSONB down to the last N turns before persisting.
//
// Schema recap:
//   line_user_id    VARCHAR(64) UNIQUE
//   history         JSONB       (array of {role, content, ts} turns)
//   current_intent  VARCHAR(100)
//   collected       JSONB       (partial-form state from interrupted flows)
//   expires_at      TIMESTAMPTZ (24h TTL; conversationStore bumps this on write)
//
// All read functions tolerate the row being missing (returns null / empty)
// — callers are expected to call getOrCreate() first.

import { query } from '../pool.js'

const COLS = `id, line_user_id, history, current_intent, collected,
              expires_at, created_at, updated_at`

function shape(row) {
  if (!row) return null
  return {
    id:            row.id,
    lineUserId:    row.line_user_id,
    history:       row.history ?? [],
    currentIntent: row.current_intent,
    collected:     row.collected ?? {},
    expiresAt:     row.expires_at,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
  }
}

/**
 * Find a session by Line user id. Returns null if not found.
 */
export async function findByLineUserId(lineUserId) {
  const { rows } = await query(
    `SELECT ${COLS} FROM chat_sessions WHERE line_user_id = $1 LIMIT 1`,
    [lineUserId],
  )
  return shape(rows[0])
}

/**
 * Read with row lock — used by conversationStore.getOrCreate to serialise
 * concurrent webhook deliveries from the same user (Line may retry before
 * the first reply lands, and race against history writes).
 */
export async function findForUpdate(client, lineUserId) {
  const { rows } = await client.query(
    `SELECT ${COLS} FROM chat_sessions
       WHERE line_user_id = $1
       FOR UPDATE`,
    [lineUserId],
  )
  return shape(rows[0])
}

/**
 * Get existing session or create a new one. Atomic — the row is guaranteed
 * to exist (and be locked) on return. Used as the first step in every
 * chatAgent.handle() call.
 *
 * @param {string} lineUserId
 * @param {object} [client]  Optional pg client (inside a transaction).
 *                           When provided, uses SELECT FOR UPDATE.
 */
export async function getOrCreate(lineUserId, client) {
  const run = client ? (sql, params) => client.query(sql, params) : query
  const existing = client ? await findForUpdate(client, lineUserId) : await findByLineUserId(lineUserId)
  if (existing) return existing
  const { rows } = await run(
    `INSERT INTO chat_sessions (line_user_id)
     VALUES ($1)
     RETURNING ${COLS}`,
    [lineUserId],
  )
  return shape(rows[0])
}

/**
 * Replace history + collected + currentIntent. Also bumps expires_at by 24h
 * so an active conversation doesn't get GC'd mid-flow.
 *
 * @param {string} lineUserId
 * @param {object} patch
 * @param {Array}  [patch.history]       Full history array (replaces, not merges).
 * @param {string} [patch.currentIntent]
 * @param {object} [patch.collected]
 * @param {object} [client]
 */
export async function update(lineUserId, { history, currentIntent, collected } = {}, client) {
  const run = client ? (sql, params) => client.query(sql, params) : query
  const { rows } = await run(
    `UPDATE chat_sessions
        SET history        = COALESCE($2::jsonb, history),
            current_intent = COALESCE($3, current_intent),
            collected      = COALESCE($4::jsonb, collected),
            expires_at     = NOW() + INTERVAL '24 hours',
            updated_at     = NOW()
      WHERE line_user_id = $1
      RETURNING ${COLS}`,
    [
      lineUserId,
      history === undefined       ? null : JSON.stringify(history),
      currentIntent === undefined ? null : currentIntent,
      collected === undefined     ? null : JSON.stringify(collected),
    ],
  )
  return shape(rows[0])
}

/**
 * Wipe a session (used after the user resets, or after admin escalates and
 * the bot flow is done). Keeps the row for history but clears everything.
 */
export async function clear(lineUserId) {
  const { rows } = await query(
    `UPDATE chat_sessions
        SET history        = '[]'::jsonb,
            current_intent = NULL,
            collected      = '{}'::jsonb,
            expires_at     = NOW() + INTERVAL '24 hours',
            updated_at     = NOW()
      WHERE line_user_id = $1
      RETURNING ${COLS}`,
    [lineUserId],
  )
  return shape(rows[0])
}

/**
 * Delete sessions whose expires_at has passed. Called by a cron-style
 * sweep from server.js (not implemented yet — placeholder for Phase 6).
 */
export async function deleteExpired() {
  const { rowCount } = await query(
    `DELETE FROM chat_sessions WHERE expires_at < NOW()`,
  )
  return rowCount
}
