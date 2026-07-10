// src/db/repositories/lineLogs.repo.js — Append-only audit log of every
// Line webhook event we receive and every message we push back.
//
// Replaces the C# bot's ts_LineWebhookLog / ts_LineReplyLog tables. The
// data shape is identical (line_user_id, reply_token, event_type, full
// event payload as JSONB, created_at). Used by:
//   - the /api/line/webhook route (records every inbound event)
//   - lineMessaging.service (records every outbound push/reply)
//   - any future "audit who said what when" admin query
//
// Best-effort writes — failures here MUST NOT block the webhook from
// returning 200 to Line (otherwise Line retries and floods us).

import { query } from '../pool.js'

const WEBHOOK_COLS = `
  id, line_user_id, reply_token, event_type, event, created_at
`
const REPLY_COLS = `
  id, line_user_id, reply_token, message, created_at
`

export async function appendWebhook({ lineUserId, replyToken, eventType, event }) {
  try {
    await query(
      `INSERT INTO line_webhook_log (line_user_id, reply_token, event_type, event)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [lineUserId ?? null, replyToken ?? null, eventType ?? null, JSON.stringify(event ?? {})],
    )
  } catch (err) {
    // Swallow — logging should never break the request path. The route logs
    // the original error to pino so we still have visibility.
  }
}

export async function appendReply({ lineUserId, replyToken, message }) {
  try {
    await query(
      `INSERT INTO line_reply_log (line_user_id, reply_token, message)
       VALUES ($1, $2, $3::jsonb)`,
      [lineUserId ?? null, replyToken ?? null, JSON.stringify(message ?? {})],
    )
  } catch (err) {
    // Same as above — never throw.
  }
}

/** Read-only helpers — used by /admin/inbox for "show full webhook payload" drill-down. */
export async function recentWebhooks({ limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${WEBHOOK_COLS}
       FROM line_webhook_log
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
    [limit, offset],
  )
  return rows.map((r) => ({
    id:          r.id,
    lineUserId:  r.line_user_id,
    replyToken:  r.reply_token,
    eventType:   r.event_type,
    event:       r.event ?? {},
    createdAt:   r.created_at,
  }))
}

export async function recentReplies({ limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${REPLY_COLS}
       FROM line_reply_log
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
    [limit, offset],
  )
  return rows.map((r) => ({
    id:         r.id,
    lineUserId: r.line_user_id,
    replyToken: r.reply_token,
    message:    r.message ?? {},
    createdAt:  r.created_at,
  }))
}