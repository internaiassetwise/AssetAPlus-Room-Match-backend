// src/db/repositories/adminQueue.repo.js — The admin's work queue.
//
// Replaces bot_inquiries (same shape, clearer name). Everything that needs a
// human lands here: FAQ misses, edit-description requests, photo uploads with
// no pending draft, viewing requests that need confirmation, listing drafts
// awaiting approval, and system errors. The admin inbox UI (Phase 5) reads
// `status='open'` rows; replying marks `replied`, closing marks `resolved`.
//
// Written by the chatbot tools (escalateToAdmin, editRoomDescription) and by
// the image path (upload-photos with no draft). Read by the admin inbox.

import { query } from '../pool.js'

const COLS = `id, line_user_id, reason, summary, original_payload, status,
              admin_reply, replied_at, resolved_at, thread,
              created_at, updated_at`

function shape(row) {
  if (!row) return null
  return {
    id:              row.id,
    lineUserId:      row.line_user_id,
    reason:          row.reason,
    summary:         row.summary,
    originalPayload: row.original_payload,
    status:          row.status,
    adminReply:      row.admin_reply,
    repliedAt:       row.replied_at,
    resolvedAt:      row.resolved_at,
    thread:          row.thread ?? [],
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
  }
}

/**
 * Enqueue an item for admin attention. Returns the new row.
 *
 * @param {object} input
 * @param {string} input.lineUserId
 * @param {string} input.reason        'faq-miss' | 'edit-description' |
 *                                     'upload-photos' | 'view-a-room' |
 *                                     'create-room-draft' | 'system-error'
 * @param {string} [input.summary]     One-line human summary (shown in inbox).
 * @param {object} [input.originalPayload] Structured context for the admin.
 */
export async function create({ lineUserId, reason, summary = null, originalPayload = null } = {}) {
  if (!lineUserId || !reason) {
    throw new Error('adminQueue.create: lineUserId + reason are required')
  }
  const { rows } = await query(
    `INSERT INTO admin_queue (line_user_id, reason, summary, original_payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING ${COLS}`,
    [lineUserId, reason, summary, JSON.stringify(originalPayload ?? {})],
  )
  return shape(rows[0])
}

/** Open items, newest first (admin inbox). Optional reason filter. */
export async function findOpen({ reason, limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT ${COLS} FROM admin_queue
      WHERE status = 'open'
        AND ($1::text IS NULL OR reason = $1)
      ORDER BY created_at DESC
      LIMIT $2`,
    [reason ?? null, Math.min(limit, 500)],
  )
  return rows.map(shape)
}

export async function findById(id) {
  const { rows } = await query(`SELECT ${COLS} FROM admin_queue WHERE id = $1`, [id])
  return shape(rows[0])
}

/** Admin replied — stamps replied_at. The reply text is pushed to the user's Line. */
export async function markReplied(id, { adminReply }) {
  const { rows } = await query(
    `UPDATE admin_queue
        SET admin_reply = $2, status = 'replied', replied_at = NOW(), updated_at = NOW()
      WHERE id = $1 RETURNING ${COLS}`,
    [id, adminReply],
  )
  return shape(rows[0])
}

/** Admin closed the item. */
export async function markResolved(id) {
  const { rows } = await query(
    `UPDATE admin_queue
        SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
      WHERE id = $1 RETURNING ${COLS}`,
    [id],
  )
  return shape(rows[0])
}

/**
 * Append one turn ({ role, text, ts }) to a live ticket's `thread`. Used by the
 * webhook (user messages while a human owns the chat) and by the inbox reply
 * path (admin messages). The ticket stays open — the thread is the transcript.
 */
export async function appendThread(id, entry) {
  const { rows } = await query(
    `UPDATE admin_queue
        SET thread = thread || $2::jsonb, updated_at = NOW()
      WHERE id = $1 RETURNING ${COLS}`,
    [id, JSON.stringify([entry])],
  )
  return shape(rows[0])
}

/** Reopen a ticket for a live takeover (clears resolved/replied state). */
export async function reopen(id) {
  const { rows } = await query(
    `UPDATE admin_queue
        SET status = 'open', resolved_at = NULL, updated_at = NOW()
      WHERE id = $1 RETURNING ${COLS}`,
    [id],
  )
  return shape(rows[0])
}

// ─── Inbox listing (Phase 5) ────────────────────────────────────────────

/** Paged inbox list, newest first. Optional status / reason filter. */
export async function list({ status, reason, limit = 100, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${COLS} FROM admin_queue
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR reason  = $2)
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4`,
    [status ?? null, reason ?? null, Math.min(limit, 500), Math.max(0, offset)],
  )
  return rows.map(shape)
}

/** Counts per status — drives the inbox summary cards / badge. */
export async function countByStatus() {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS n FROM admin_queue GROUP BY status`,
  )
  const out = { open: 0, replied: 0, resolved: 0 }
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + r.n
  return out
}
