// src/linebot/tools/escalateToAdmin.js — Hand the conversation to a human admin.
//
// The catch-all exit ramp: when the bot cannot resolve a request — FAQ miss,
// something out of scope, a complaint, a landlord action that needs moderation,
// any dead end — this tool enqueues an admin_queue row so a human can take over.
// It never answers the user itself; it only records what the user wanted and
// returns { escalated: true }, leaving the model to phrase the Thai "we'll have
// someone get back to you" reply.

import { alertAdmins } from '../adminAlert.service.js'
import * as chatSessions from '../../db/repositories/chatSessions.repo.js'

export const name = 'escalateToAdmin'

// The ONLY text Gemini sees when deciding whether to call this tool, so be
// specific about WHEN to use it vs. the more targeted tools and WHAT it returns.
export const description =
  'Escalate a Room Match rental conversation to a human admin when the bot cannot resolve ' +
  "the user's IN-SCOPE request — e.g. an FAQ the bot could not answer, a complaint, a " +
  'viewing/booking issue, a landlord listing or photo request, or any room-rental matter that ' +
  'needs a human action. Use this as the last resort AFTER the specific tools (FAQ, room ' +
  'details, viewing, edit description, etc.) are not applicable. ' +
  'Do NOT use this for OFF-TOPIC / out-of-scope questions (general knowledge, news, weather, ' +
  'other products, homework/code, etc.) — those must be politely declined and steered back to ' +
  'room rentals WITHOUT escalating (escalating off-topic spam is wrong). ' +
  'Requires a short summary of what the user wants (in the language the user is writing in); ' +
  "optionally a reason and the original user message. Returns { escalated: true } — it does NOT " +
  'answer the user, it only queues the request for an admin to follow up.'

export const parameters = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description:
        'Optional free-text hint about WHY this is being escalated ' +
        '(e.g. "faq miss", "edit description", "upload photos", "view a room", ' +
        '"create room listing"). Mapped to an internal admin-queue reason.',
    },
    summary: {
      type: 'string',
      description: 'One-line Thai summary of what the user wants. Required.',
    },
    originalMessage: {
      type: 'string',
      description: 'The user message that triggered the escalation, if any.',
    },
  },
  required: ['summary'],
}

// admin_queue.reason is an enum column, so the model's free-text hint must be
// narrowed to one of the allowed values. Order matters: a reason like "upload a
// photo of my room" should hit the photo/upload branch before the room branch.
const ALLOWED_REASONS = new Set([
  'faq-miss',
  'edit-description',
  'upload-photos',
  'view-a-room',
  'create-room-draft',
  'system-error',
])

/**
 * Map a free-text reason hint onto one of the allowed admin_queue reasons.
 * Falls back to 'faq-miss' when nothing matches (the most common escalation).
 *
 * @param {string} [raw]
 * @returns {string}
 */
function mapReason(raw) {
  const r = (raw ?? '').toLowerCase()
  if (r.includes('faq')) return 'faq-miss'
  if (r.includes('description')) return 'edit-description'
  if (r.includes('photo') || r.includes('upload')) return 'upload-photos'
  if (r.includes('view') || r.includes('นัดชม')) return 'view-a-room'
  if (r.includes('room') || r.includes('listing') || r.includes('ปล่อย')) return 'create-room-draft'
  return 'faq-miss'
}

/**
 * Enqueue an admin follow-up for the current Line user.
 *
 * @param {object} args  { reason?: string, summary: string, originalMessage?: string }
 * @param {object} ctx   { lineUserId: string, logger: import('pino').Logger }
 * @returns {Promise<{escalated: boolean, reason: string} | {error: string}>}
 */
export async function handler(args, ctx) {
  const { reason: hint, summary, originalMessage } = args ?? {}
  const log = ctx.logger

  // summary is the only required field — it's what the admin sees in the inbox,
  // so refuse to enqueue a blank one rather than create an unusable ticket.
  if (typeof summary !== 'string' || !summary.trim()) {
    log.warn({ tool: name, lineUserId: ctx.lineUserId }, 'escalateToAdmin: missing summary')
    return { error: 'summary is required' }
  }

  const reason = mapReason(hint)

  // Defensive: if mapReason ever returned something off the enum the INSERT
  // would throw anyway — this keeps the error message honest.
  if (!ALLOWED_REASONS.has(reason)) {
    log.error({ tool: name, lineUserId: ctx.lineUserId, reason }, 'escalateToAdmin: invalid reason')
    return { error: 'invalid reason' }
  }

  try {
    // Capture the user's verbatim message (if provided) inside originalPayload
    // so the admin has full context alongside the model's summary.
    const ticket = await alertAdmins({
      lineUserId:      ctx.lineUserId,
      reason,
      summary:         summary.trim(),
      originalPayload: { message: originalMessage ?? null },
    })
    // (alertAdmins also pushes to the admin Line group if configured)

    // Live takeover: mute the bot for this user and link the new ticket, so the
    // user's next messages go straight to the admin (via the inbox thread) and
    // skip Gemini until the admin hands control back.
    await chatSessions.beginTakeover(ctx.lineUserId, { ticketId: ticket?.id })

    log.info(
      { tool: name, lineUserId: ctx.lineUserId, reason, ticketId: ticket?.id },
      'escalated to admin queue — live takeover started',
    )

    return { escalated: true, reason, live: true }
  } catch (err) {
    // Unexpected DB failure — surface as a soft error so the model can relay a
    // polite Thai fallback instead of crashing the whole turn.
    log.error({ err, tool: name, lineUserId: ctx.lineUserId, reason }, 'escalateToAdmin failed')
    return { error: 'escalation failed' }
  }
}
