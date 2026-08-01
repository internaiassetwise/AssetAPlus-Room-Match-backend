// src/services/maintenance.service.js — Periodic housekeeping.
//
// WHY: several tables grow forever with nothing pruning them.
//   • *_sessions      — rows are only deleted on explicit logout. Expired
//                       sessions are rejected at lookup (expires_at > NOW()), so
//                       this is hygiene, not a security hole — but the tables
//                       still grow unbounded.
//   • chat_sessions   — chatSessions.deleteExpired() existed but NOTHING ever
//                       called it.
//   • line_*_log      — one row per inbound event / outbound reply, forever.
//
// Retention is deliberately conservative: audit trails (admin_action_log) are
// NOT touched here — they exist to answer "who changed this?" months later, and
// deleting them silently would defeat the point. Prune those manually if needed.
//
// Runs on a plain setInterval (same pattern as viewingReminder). Each sweep is
// independent and best-effort: one failing statement never blocks the others.

import { query } from '../db/pool.js'
import { logger } from '../logger.js'
import { config } from '../config.js'
import * as chatSessions from '../db/repositories/chatSessions.repo.js'

const DAY_MS = 24 * 60 * 60_000
const FIRST_RUN_DELAY_MS = 60_000        // let the app finish booting first

/** Run one statement, logging + swallowing its error so the sweep continues. */
async function step(label, fn) {
  try {
    const n = await fn()
    if (n) logger.info({ label, rows: n }, 'maintenance: pruned')
    return n || 0
  } catch (err) {
    logger.error({ err, label }, 'maintenance step failed')
    return 0
  }
}

/**
 * One full housekeeping pass. Exported so it can be run manually/tested.
 * Never throws.
 */
export async function runMaintenance() {
  const logDays = config.LOG_RETENTION_DAYS
  const results = {}

  // Expired auth sessions across all three roles.
  for (const t of ['user_sessions', 'landlord_sessions', 'admin_sessions']) {
    results[t] = await step(t, async () => {
      const { rowCount } = await query(`DELETE FROM ${t} WHERE expires_at < NOW()`)
      return rowCount
    })
  }

  // Bot conversation state whose TTL has passed.
  results.chat_sessions = await step('chat_sessions', () => chatSessions.deleteExpired())

  // Line traffic logs older than the retention window. These are diagnostic —
  // the durable record of what a customer asked lives in admin_queue.
  if (logDays > 0) {
    for (const t of ['line_webhook_log', 'line_reply_log']) {
      results[t] = await step(t, async () => {
        const { rowCount } = await query(
          `DELETE FROM ${t} WHERE created_at < NOW() - ($1 || ' days')::interval`,
          [String(logDays)],
        )
        return rowCount
      })
    }
  }

  const total = Object.values(results).reduce((a, b) => a + b, 0)
  logger.info({ ...results, total, logDays }, 'maintenance sweep done')
  return results
}

let timer = null

/** Start the daily sweep. Idempotent; timers are unref'd so shutdown isn't blocked. */
export function start() {
  if (timer) return
  const intervalMs = Number(process.env.MAINTENANCE_INTERVAL_MS) || DAY_MS
  setTimeout(() => { runMaintenance() }, FIRST_RUN_DELAY_MS).unref()
  timer = setInterval(() => { runMaintenance() }, intervalMs)
  timer.unref()
  logger.info({ intervalMs, logRetentionDays: config.LOG_RETENTION_DAYS }, 'maintenance scheduler started')
}

/** Stop the sweep (graceful shutdown / tests). */
export function stop() {
  if (timer) { clearInterval(timer); timer = null }
}
