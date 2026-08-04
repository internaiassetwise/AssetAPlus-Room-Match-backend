// src/linebot/tools/scheduleViewing.js — Show bookable viewing slots (Phase 6).
//
// A TENANT wants to view a room. Instead of guessing a time, this tool shows the
// bookable time slots the admin opened for that room as tappable Flex buttons.
// The tenant books by TAPPING a button → a postback event → the webhook's
// handlePostback() creates the viewing (deterministic, no LLM). So this tool
// never creates a viewing itself; it only offers slots.

import { findById } from '../../db/repositories/rooms.repo.js'
import { alertAdmins } from '../adminAlert.service.js'

export const name = 'scheduleViewing'

export const description =
  "Show a tenant the available bookable viewing times for a room, as tappable buttons. " +
  'Use this when a tenant wants to view/visit/see a room in person (นัดชมห้อง, ดูห้อง, จองเวลาชม). ' +
  'Pass the room id. Returns hasSlots: true when bookable times were shown as buttons (the tenant ' +
  'books by tapping one) or hasSlots: false when no times are open. When hasSlots is false, tell the ' +
  'tenant that no times are open right now and an admin will contact them — do NOT ask the tenant to ' +
  'type a time. Do NOT call this for browsing/searching rooms (use the search tool).'

export const parameters = {
  type: 'object',
  properties: {
    roomId: {
      type: 'integer',
      description: 'Id of the available room the tenant wants to view.',
    },
  },
  required: ['roomId'],
}

export async function handler(args, ctx) {
  const { logger } = ctx
  const roomId = Number(args?.roomId)

  const room = Number.isInteger(roomId) ? await findById(roomId) : null
  if (!room || room.status !== 'available') {
    logger.info({ tool: name, roomId: args?.roomId, reason: 'room not found or not available' }, 'scheduleViewing: no room')
    return { error: 'room not found or not available' }
  }

  // Every viewing request is now an admin task. The self-service slot flow is
  // gone: admins book the appointment themselves in /admin/viewings, which is
  // what they were doing anyway — opening slots per room was an extra step
  // that had to happen BEFORE a customer could ask, so in practice the "no
  // slots" branch was the only one anyone hit.
  // Best-effort: a DB failure here must not break the reply.
  try {
    await alertAdmins({
      lineUserId:      ctx.lineUserId,
      reason:          'view-a-room',
      summary:         `ลูกค้าต้องการนัดชมห้อง "${room.title}" (ห้อง #${roomId}) — รบกวนติดต่อกลับเพื่อนัดวันเวลา`,
      originalPayload: { roomId, roomTitle: room.title, want: 'viewing-request' },
    })
    logger.info({ tool: name, roomId, lineUserId: ctx.lineUserId }, 'scheduleViewing: admin alerted')
  } catch (err) {
    logger.error({ err, tool: name, roomId }, 'scheduleViewing: admin alert failed')
  }
  return { hasSlots: false, roomTitle: room.title, adminAlerted: true }
}
