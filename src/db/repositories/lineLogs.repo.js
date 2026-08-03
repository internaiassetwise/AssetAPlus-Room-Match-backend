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

/**
 * The FULL transcript of one 1:1 chat, rebuilt by merging the inbound and
 * outbound logs on time.
 *
 * WHY not chat_sessions.history: that is the model's *context window*, not a
 * transcript. It holds only what the LLM needs — so stickers, the admin's own
 * replies, and the takeover/release notices never appear in it, and it is wiped
 * after 24h. Admins comparing the inbox against LINE saw entire messages
 * missing. These two logs, by contrast, record literally every event LINE sent
 * us and every message we sent back, and are kept for LOG_RETENTION_DAYS.
 *
 * Replies sent the free way were logged with line_user_id = NULL (fixed in
 * lineMessaging, but old rows remain), so outbound rows are re-attributed via
 * the reply_token they share with the inbound event — that recovers the history
 * written before the fix instead of leaving a gap.
 *
 * @returns {Promise<Array<{direction:'in'|'out', kind:string, text:string, ts:string}>>}
 */
export async function loadTranscript(lineUserId, { limit = 200 } = {}) {
  if (!lineUserId) return []
  const [inbound, outbound] = await Promise.all([
    query(
      `SELECT event_type, event, created_at FROM line_webhook_log
        WHERE line_user_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [lineUserId, limit],
    ),
    query(
      `SELECT r.message, r.created_at
         FROM line_reply_log r
         LEFT JOIN LATERAL (
           SELECT w.line_user_id FROM line_webhook_log w
            WHERE w.reply_token = r.reply_token AND w.line_user_id IS NOT NULL
            LIMIT 1
         ) w ON TRUE
        WHERE COALESCE(r.line_user_id, w.line_user_id) = $1
        ORDER BY r.created_at DESC LIMIT $2`,
      [lineUserId, limit],
    ),
  ])

  const out = []
  for (const r of inbound.rows) {
    const text = describeInbound(r.event_type, r.event)
    if (text != null) out.push({ direction: 'in', kind: r.event_type, text, ts: r.created_at })
  }
  for (const r of outbound.rows) {
    for (const m of (r.message?.messages ?? [])) {
      out.push({ direction: 'out', kind: m?.type ?? 'text', text: describeOutbound(m), ts: r.created_at })
    }
  }
  // Oldest first, the way a chat reads.
  return out.sort((a, b) => new Date(a.ts) - new Date(b.ts)).slice(-limit)
}

/** One inbound LINE event as a transcript line. null = not worth showing. */
function describeInbound(eventType, event) {
  if (eventType === 'postback') return '[กดปุ่มในแชท]'
  if (eventType === 'follow')   return '[เพิ่มเพื่อน]'
  if (eventType === 'unfollow') return '[บล็อก/ลบเพื่อน]'
  if (eventType !== 'message')  return null
  const m = event?.message ?? {}
  switch (m.type) {
    case 'text':     return m.text ?? ''
    case 'sticker':  return '[สติกเกอร์]'
    case 'image':    return '[รูปภาพ]'
    case 'video':    return '[วิดีโอ]'
    case 'audio':    return '[เสียง]'
    case 'file':     return `[ไฟล์${m.fileName ? ` ${m.fileName}` : ''}]`
    case 'location': return `[ตำแหน่ง${m.address ? ` ${m.address}` : ''}]`
    default:         return '[ข้อความ]'
  }
}

/** One outbound LINE message object as a transcript line. */
function describeOutbound(m) {
  if (!m || typeof m !== 'object') return '[ข้อความ]'
  if (m.type === 'text') return m.text ?? ''
  // Flex/template carry a human-readable altText — that's what LINE itself shows
  // in the chat list, so it's the right label for the transcript too.
  if (m.altText) return `[${m.altText}]`
  if (m.type === 'image') return '[รูปภาพ]'
  if (m.type === 'sticker') return '[สติกเกอร์]'
  return `[${m.type || 'ข้อความ'}]`
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