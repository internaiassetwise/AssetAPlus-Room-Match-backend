// src/middleware/auditAdmin.js — Auto-log every admin write (POST/PATCH/DELETE).
//
// Mounted after requireAdmin on admin-gated routers. Listens for the response
// 'finish' event (fires after the response is sent) and writes one audit row.
// Non-blocking: the log insert is fire-and-forget — a DB failure can't break
// the request because the response has already been sent.
//
// The middleware derives a human-readable action label (e.g. "room.approve")
// from the route pattern so handlers don't need to call log() explicitly for
// basic tracking. Handlers CAN call log() directly for richer metadata.

import * as adminActions from '../db/repositories/adminActions.repo.js'

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

/**
 * Derive { action, entityType } from the matched route path + method.
 * Returns null for non-matching routes (GET, unknown patterns).
 *
 * Example mappings:
 *   POST   /api/rooms/:id/approve     → { action: 'room.approve',     entityType: 'room' }
 *   PATCH  /api/faqs/:id              → { action: 'faq.update',        entityType: 'faq' }
 *   POST   /api/admin/inbox/:id/reply → { action: 'inbox.reply',       entityType: 'inbox_ticket' }
 *   DELETE /api/rooms/:id             → { action: 'room.delete',       entityType: 'room' }
 */
function classify(method, path) {
  if (!MUTATING.has(method)) return null

  // Normalise: strip /api/v1 prefix, collapse trailing slashes.
  const p = path.replace(/^\/api(?:\/v1)?\b/, '').replace(/\/+$/, '')

  // rooms
  let m
  if ((m = p.match(/^\/rooms\/(\d+)\/approve$/))) return { action: 'room.approve', entityType: 'room', entityId: m[1] }
  if ((m = p.match(/^\/rooms\/(\d+)\/reject$/)))  return { action: 'room.reject',  entityType: 'room', entityId: m[1] }
  if ((m = p.match(/^\/rooms\/(\d+)\/photos$/)) && method === 'POST') return { action: 'room.photo.upload', entityType: 'room', entityId: m[1] }
  if ((m = p.match(/^\/rooms\/(\d+)\/photos\/(\d+)$/))) return { action: 'room.photo.delete', entityType: 'room', entityId: m[1] }
  if ((m = p.match(/^\/rooms\/(\d+)\/slots$/)) && method === 'POST') return { action: 'room.slot.create', entityType: 'room', entityId: m[1] }
  if ((m = p.match(/^\/rooms\/slots\/(\d+)$/)))  return { action: 'room.slot.cancel', entityType: 'viewing_slot', entityId: m[1] }
  if ((m = p.match(/^\/rooms\/(\d+)$/)) && method === 'PATCH')  return { action: 'room.update', entityType: 'room', entityId: m[1] }
  if ((m = p.match(/^\/rooms\/(\d+)$/)) && method === 'DELETE') return { action: 'room.delete', entityType: 'room', entityId: m[1] }
  if (p === '/rooms' && method === 'POST') return { action: 'room.create', entityType: 'room' }

  // admin inbox (bot escalations)
  if ((m = p.match(/^\/admin\/inbox\/(\d+)\/reply$/)))   return { action: 'inbox.reply', entityType: 'inbox_ticket', entityId: m[1] }
  if ((m = p.match(/^\/admin\/inbox\/(\d+)\/resolve$/))) return { action: 'inbox.resolve', entityType: 'inbox_ticket', entityId: m[1] }
  if ((m = p.match(/^\/admin\/inbox\/(\d+)\/takeover$/)))return { action: 'inbox.takeover', entityType: 'inbox_ticket', entityId: m[1] }
  if ((m = p.match(/^\/admin\/inbox\/(\d+)\/release$/))) return { action: 'inbox.release', entityType: 'inbox_ticket', entityId: m[1] }

  // admin viewings
  if ((m = p.match(/^\/admin\/viewings\/(\d+)\/confirm$/))) return { action: 'viewing.confirm', entityType: 'viewing', entityId: m[1] }
  if ((m = p.match(/^\/admin\/viewings\/(\d+)\/decline$/))) return { action: 'viewing.decline', entityType: 'viewing', entityId: m[1] }

  // faqs
  if ((m = p.match(/^\/faqs\/(\d+)$/)) && method === 'PATCH')  return { action: 'faq.update', entityType: 'faq', entityId: m[1] }
  if ((m = p.match(/^\/faqs\/(\d+)$/)) && method === 'DELETE') return { action: 'faq.delete', entityType: 'faq', entityId: m[1] }
  if ((m = p.match(/^\/faqs\/(\d+)\/regenerate-embedding$/))) return { action: 'faq.regenerate_embedding', entityType: 'faq', entityId: m[1] }
  if (p === '/faqs' && method === 'POST') return { action: 'faq.create', entityType: 'faq' }

  // landlords
  if ((m = p.match(/^\/landlords\/(\d+)$/)) && method === 'PATCH') return { action: 'landlord.update', entityType: 'landlord', entityId: m[1] }

  // bot inquiries
  if ((m = p.match(/^\/admin\/bot-inquiries\/(\d+)\/resolve$/))) return { action: 'bot_inquiry.resolve', entityType: 'bot_inquiry', entityId: m[1] }

  // Fallback: still log but with a generic action label so nothing is missed.
  return { action: `${method.toLowerCase()}.unknown`, entityType: null }
}

/**
 * Express middleware. Place AFTER requireAdmin so req.admin is populated.
 * Logs on res 'finish' so the statusCode is known and the response is already
 * out the door — the audit insert can't delay or break the request.
 */
export function auditAdmin(req, res, next) {
  if (!MUTATING.has(req.method)) return next()

  // Attach the listener NOW (before requireAdmin runs), but check req.admin
  // INSIDE the callback — by the time 'finish' fires, requireAdmin has
  // populated req.admin for authenticated routes.
  res.on('finish', () => {
    if (!req.admin) return
    const cls = classify(req.method, req.originalUrl || req.path)
    if (!cls) return
    adminActions.log({
      adminId:     req.admin.id,
      azureOid:    req.admin.azureOid,
      displayName: req.admin.displayName,
      method:      req.method,
      path:        req.originalUrl || req.path,
      action:      cls.action,
      entityType:  cls.entityType,
      entityId:    cls.entityId,
      statusCode:  res.statusCode,
    })
  })

  next()
}
