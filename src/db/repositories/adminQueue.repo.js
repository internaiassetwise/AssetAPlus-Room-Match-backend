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

// Resolve the user's display name from their Line id — a bot user is a tenant
// and/or a landlord, both keyed by line_id. Correlated subqueries (not JOINs) so
// one admin_queue row never fans out even if a line_id maps to >1 row. The name
// is the LINE displayName the bot backfills on first contact (refreshFromLine).
const NAME_EXPR = `COALESCE(
  NULLIF(TRIM((SELECT full_name FROM tenants   WHERE line_id = q.line_user_id ORDER BY id LIMIT 1)), ''),
  NULLIF(TRIM((SELECT full_name FROM landlords WHERE line_id = q.line_user_id ORDER BY id LIMIT 1)), '')
) AS user_name`

function shape(row) {
  if (!row) return null
  return {
    id:              row.id,
    lineUserId:      row.line_user_id,
    userName:        row.user_name ?? null,
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
  const { rows } = await query(
    `SELECT ${COLS}, ${NAME_EXPR} FROM admin_queue q WHERE id = $1`, [id],
  )
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
    `SELECT ${COLS}, ${NAME_EXPR} FROM admin_queue q
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR reason  = $2)
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4`,
    [status ?? null, reason ?? null, Math.min(limit, 500), Math.max(0, offset)],
  )
  return rows.map(shape)
}

/**
 * Every conversation, not just the escalated ones.
 *
 * WHY: the inbox used to list admin_queue rows only, so a chat appeared solely
 * once the bot gave up or the customer thought to press "ติดต่อแอดมิน". Most
 * customers never do, so real conversations stayed invisible to admin. This
 * lists one row per LINE user who has ever written in, with the escalated ones
 * floated to the top.
 *
 * Source is line_webhook_log rather than chat_sessions: sessions expire after
 * 24h and the maintenance sweep deletes them, which would silently drop
 * yesterday's chats from the list. The log is kept for LOG_RETENTION_DAYS.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {'all'|'needs_admin'|'bot'} [opts.filter]
 */
export async function listConversations({ limit = 100, filter = 'all' } = {}) {
  const { rows } = await query(
    `WITH last_msg AS (
       SELECT DISTINCT ON (line_user_id)
              line_user_id, created_at,
              COALESCE(
                NULLIF(event::json->'message'->>'text', ''),
                CASE WHEN event::json->'message'->>'type' = 'image' THEN '[ส่งรูปภาพ]' END,
                CASE WHEN event_type = 'postback' THEN '[กดปุ่มในแชท]' END,
                ''
              ) AS last_text
         FROM line_webhook_log
        WHERE line_user_id IS NOT NULL
          AND event_type IN ('message', 'postback')
        ORDER BY line_user_id, created_at DESC
     ), tix AS (
       -- Prefer a still-open ticket; otherwise the most recent one.
       SELECT DISTINCT ON (line_user_id)
              line_user_id, id AS ticket_id, status, reason, summary
         FROM admin_queue
        ORDER BY line_user_id, (status = 'open') DESC, created_at DESC
     )
     SELECT m.line_user_id, m.created_at AS last_at, m.last_text,
            t.ticket_id, t.status AS ticket_status, t.reason, t.summary,
            COALESCE(
              NULLIF(TRIM((SELECT full_name FROM tenants   WHERE line_id = m.line_user_id ORDER BY id LIMIT 1)), ''),
              NULLIF(TRIM((SELECT full_name FROM landlords WHERE line_id = m.line_user_id ORDER BY id LIMIT 1)), '')
            ) AS user_name
       FROM last_msg m
       LEFT JOIN tix t ON t.line_user_id = m.line_user_id
      WHERE ($2::text = 'all'
             OR ($2 = 'needs_admin' AND t.status = 'open')
             OR ($2 = 'bot' AND (t.status IS NULL OR t.status <> 'open')))
      ORDER BY (t.status = 'open') DESC NULLS LAST, m.created_at DESC
      LIMIT $1`,
    [Math.min(limit, 300), filter],
  )
  return rows.map((r) => ({
    lineUserId:   r.line_user_id,
    userName:     r.user_name,
    lastText:     r.last_text,
    lastAt:       r.last_at,
    ticketId:     r.ticket_id,
    ticketStatus: r.ticket_status,
    reason:       r.reason,
    summary:      r.summary,
    needsAdmin:   r.ticket_status === 'open',
  }))
}

/** Tallies for the conversation list's filter cards. */
export async function countConversations() {
  const { rows } = await query(
    `WITH users AS (
       SELECT DISTINCT line_user_id FROM line_webhook_log
        WHERE line_user_id IS NOT NULL AND event_type IN ('message', 'postback')
     ), tix AS (
       SELECT DISTINCT ON (line_user_id) line_user_id, status
         FROM admin_queue ORDER BY line_user_id, (status = 'open') DESC, created_at DESC
     )
     SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE t.status = 'open')::int AS needs_admin
       FROM users u LEFT JOIN tix t ON t.line_user_id = u.line_user_id`,
  )
  const r = rows[0] || { total: 0, needs_admin: 0 }
  return { total: r.total, needsAdmin: r.needs_admin, bot: r.total - r.needs_admin }
}

/** The user's still-open ticket, or null. */
export async function findOpenByLineUser(lineUserId) {
  const { rows } = await query(
    `SELECT ${COLS}, ${NAME_EXPR} FROM admin_queue q
      WHERE line_user_id = $1 AND status = 'open'
      ORDER BY created_at DESC LIMIT 1`,
    [lineUserId],
  )
  return shape(rows[0])
}

/**
 * Get an open ticket for this user, creating one if none exists.
 * Lets admin start a conversation with someone who never escalated — the reply
 * / takeover machinery all hangs off a ticket id.
 */
export async function findOrCreateOpenTicket(lineUserId, { summary } = {}) {
  const { rows } = await query(
    `SELECT ${COLS} FROM admin_queue
      WHERE line_user_id = $1 AND status = 'open'
      ORDER BY created_at DESC LIMIT 1`,
    [lineUserId],
  )
  if (rows[0]) return shape(rows[0])
  const created = await query(
    `INSERT INTO admin_queue (line_user_id, reason, summary, original_payload)
     VALUES ($1, 'faq-miss', $2, '{}'::jsonb)
     RETURNING ${COLS}`,
    [lineUserId, summary || 'แอดมินเปิดคุยกับลูกค้าเอง'],
  )
  return shape(created.rows[0])
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
