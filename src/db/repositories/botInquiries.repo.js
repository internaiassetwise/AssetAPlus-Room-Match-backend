// src/db/repositories/botInquiries.repo.js — Inbox of inquiries the bot
// forwards to admin when it can't answer on its own.
//
// One row per bot-forwarded inquiry. Status lifecycle:
//   open       — admin hasn't touched it (newest first in the inbox)
//   replied    — admin replied; we already pushed to the tenant via
//                /api/admin/push on the bot
//   resolved   — closed without sending (e.g. duplicate, not actionable)

import { query } from '../pool.js'

const SELECT_COLS = `
  id, line_user_id, inquiry_type, payload, status,
  admin_reply, replied_at, resolved_at,
  created_at, updated_at
`

function rowToInquiry(row) {
  if (!row) return null
  return {
    id:           row.id,
    lineUserId:   row.line_user_id,
    inquiryType:  row.inquiry_type,
    payload:      row.payload ?? {},
    status:       row.status,
    adminReply:   row.admin_reply ?? null,
    repliedAt:    row.replied_at ?? null,
    resolvedAt:   row.resolved_at ?? null,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
  }
}

// ----- read ---------------------------------------------------------------

/** Admin inbox: paginated, status-filtered, newest-first. */
export async function list({ status = null, limit = 50, offset = 0 } = {}) {
  const params = []
  let where = ''
  if (status) {
    params.push(status)
    where = `WHERE status = $${params.length}`
  }
  params.push(limit, offset)
  const { rows } = await query(
    `SELECT ${SELECT_COLS}
       FROM bot_inquiries
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  return rows.map(rowToInquiry)
}

export async function countByStatus() {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS n FROM bot_inquiries GROUP BY status`,
  )
  const out = { open: 0, replied: 0, resolved: 0 }
  for (const r of rows) out[r.status] = r.n
  return out
}

export async function findById(id) {
  const { rows } = await query(
    `SELECT ${SELECT_COLS} FROM bot_inquiries WHERE id = $1`,
    [id],
  )
  return rowToInquiry(rows[0])
}

/** True if this user already has an open inquiry of the same type — used
 *  by the bot to avoid stacking duplicates. */
export async function hasOpenOfType(lineUserId, inquiryType) {
  const { rows } = await query(
    `SELECT 1 FROM bot_inquiries
       WHERE line_user_id = $1 AND inquiry_type = $2 AND status = 'open'
       LIMIT 1`,
    [lineUserId, inquiryType],
  )
  return rows.length > 0
}

// ----- write --------------------------------------------------------------

export async function create({ lineUserId, inquiryType, payload = {} }) {
  const { rows } = await query(
    `INSERT INTO bot_inquiries (line_user_id, inquiry_type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING ${SELECT_COLS}`,
    [lineUserId, inquiryType, JSON.stringify(payload)],
  )
  return rowToInquiry(rows[0])
}

/** Mark as replied + record admin's text. Called by the route after the
 *  bot push call succeeds so we don't mark inquiries replied when the
 *  tenant never actually got the message. */
export async function markReplied(id, replyText) {
  const { rows } = await query(
    `UPDATE bot_inquiries
        SET status = 'replied',
            admin_reply = $2,
            replied_at  = NOW()
      WHERE id = $1
      RETURNING ${SELECT_COLS}`,
    [id, replyText],
  )
  return rowToInquiry(rows[0])
}

export async function markResolved(id) {
  const { rows } = await query(
    `UPDATE bot_inquiries
        SET status = 'resolved',
            resolved_at = NOW()
      WHERE id = $1
      RETURNING ${SELECT_COLS}`,
    [id],
  )
  return rowToInquiry(rows[0])
}