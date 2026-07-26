// src/linebot/viewingReminder.service.js — Proactive LINE reminders for a
// tenant's upcoming นัดชมห้อง (room viewing).
//
// Two reminders per viewing, sent via metered pushMessage (no webhook token
// exists — these fire on a timer, not in response to a user message):
//   • 24h — when the viewing is 2h..24h away  ("you have a viewing")
//   • 2h  — when the viewing is within the last 2h  ("it's almost time")
//
// The scheduler is a plain setInterval (same pattern as rateLimit's sweep and
// oidcStateStore's cleanup) — no cron dependency. Each tick claims the due rows
// atomically in the DB (claimDueViewingReminders), so a reminder goes out at
// most once even across restarts or multiple app instances. start() is called
// from server.js AFTER the HTTP server is listening, so scripts/tests that
// import the repo don't spin up a timer.

import { logger } from '../logger.js'
import * as viewings from '../db/repositories/viewings.repo.js'
import * as line from './lineMessaging.service.js'

const DEFAULT_INTERVAL_MS = 5 * 60_000   // check every 5 minutes
const FIRST_RUN_DELAY_MS  = 30_000       // first sweep 30s after boot

/** Format a timestamp for the reminder, in the tenant's timezone (ICT). */
function bangkokDateTime(iso) {
  try {
    return new Date(iso).toLocaleString('th-TH', {
      timeZone: 'Asia/Bangkok', dateStyle: 'long', timeStyle: 'short',
    })
  } catch {
    return String(iso)
  }
}

function reminderText(windowKind, roomTitle, scheduledFor) {
  const when = bangkokDateTime(scheduledFor)
  const room = roomTitle ? `“${roomTitle}”` : 'ห้องที่คุณนัดไว้'
  if (windowKind === '2h') {
    return `⏰ ใกล้ถึงเวลานัดชมห้องแล้วค่ะ\nห้อง ${room}\n🗓 ${when}\n\nอีกไม่นานเจอกันนะคะ 😊`
  }
  return `🔔 แจ้งเตือนนัดชมห้อง\nคุณมีนัดชมห้อง ${room}\n🗓 ${when}\n\nแล้วเจอกันนะคะ 😊`
}

/**
 * Claim + send every due reminder for one window. The DB claim stamps the row
 * BEFORE we push, so a transient push failure loses that one reminder rather
 * than risking a duplicate on the next tick — the right trade-off for a
 * courtesy notification.
 */
async function runWindow(windowKind) {
  const due = await viewings.claimDueViewingReminders(windowKind)
  if (!due.length) return 0
  let sent = 0
  for (const v of due) {
    try {
      await line.pushMessage(v.tenant_line_user_id, {
        type: 'text',
        text: reminderText(windowKind, v.room_title, v.scheduled_for),
      })
      sent++
    } catch (err) {
      logger.error({ err, viewingId: v.id, windowKind }, 'viewing reminder push failed')
    }
  }
  logger.info({ windowKind, due: due.length, sent }, 'viewing reminders sent')
  return sent
}

/** One full sweep (both windows). Exported for manual/tested runs. Never throws. */
export async function runReminderTick() {
  if (!line.isConfigured()) return   // no LINE creds → nothing to deliver
  try {
    await runWindow('24h')
    await runWindow('2h')
  } catch (err) {
    logger.error({ err }, 'viewing reminder tick failed')
  }
}

let timer = null

/** Start the periodic scheduler. Idempotent. */
export function start() {
  if (timer) return
  const intervalMs = Number(process.env.VIEWING_REMINDER_INTERVAL_MS) || DEFAULT_INTERVAL_MS
  // Kick off shortly after boot, then on the interval. unref() so the timers
  // never keep the process alive during shutdown.
  setTimeout(() => { runReminderTick() }, FIRST_RUN_DELAY_MS).unref()
  timer = setInterval(() => { runReminderTick() }, intervalMs)
  timer.unref()
  logger.info({ intervalMs }, 'viewing reminder scheduler started')
}

/** Stop the scheduler (used on graceful shutdown / tests). */
export function stop() {
  if (timer) { clearInterval(timer); timer = null }
}
