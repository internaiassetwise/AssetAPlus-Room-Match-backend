// src/linebot/tools/scheduleViewing.js — Show bookable viewing slots (Phase 6).
//
// A TENANT wants to view a room. Instead of guessing a time, this tool shows the
// bookable time slots the admin opened for that room as tappable Flex buttons.
// The tenant books by TAPPING a button → a postback event → the webhook's
// handlePostback() creates the viewing (deterministic, no LLM). So this tool
// never creates a viewing itself; it only offers slots.

import { findById } from '../../db/repositories/rooms.repo.js'
import { openForRoom } from '../../db/repositories/viewingSlots.repo.js'
import { slotCarousel } from '../flexMessages.js'

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

  const slots = await openForRoom(roomId)
  if (slots.length === 0) {
    logger.info({ tool: name, roomId }, 'scheduleViewing: no open slots')
    return { hasSlots: false, roomTitle: room.title }
  }

  logger.info({ tool: name, roomId, slots: slots.length }, 'scheduleViewing: offered slots')
  return {
    hasSlots: true,
    count: slots.length,
    roomTitle: room.title,
    _push: [slotCarousel(room.title, slots)],
  }
}
