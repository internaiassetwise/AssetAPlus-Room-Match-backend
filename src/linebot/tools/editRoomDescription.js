// src/linebot/tools/editRoomDescription.js — Escalate a room-description
// edit request to the admin queue.
//
// SECURITY-CRITICAL — READ BEFORE EDITING:
// The bot is NEVER allowed to write a room's description. That field is
// admin-only by product rule, so a landlord's proposed text must always go
// through human review. This handler MUST NEVER import or call
// rooms.repo.update (or any write to rooms.description). All it does is
// capture the landlord's proposed text and enqueue it for an admin. If you
// ever feel tempted to "just save it directly" here, don't — that would let
// any landlord rewrite listing copy with no moderation.

import { create } from '../../db/repositories/adminQueue.repo.js'

export const name = 'editRoomDescription'

export const description =
  'Use on the Room Match rental platform when a landlord asks to change or ' +
  'update the description of one of their listed rooms. This tool does NOT ' +
  'edit the room — room descriptions are admin-only, so it escalates the ' +
  "landlord's proposed new description to an admin queue for review. " +
  'Requires a roomId (integer) and the new description text (string). ' +
  'Returns { escalated: true, roomId }.'

export const parameters = {
  type: 'object',
  properties: {
    roomId: {
      type: 'integer',
      description: 'The id of the room whose description the landlord wants to edit.',
    },
    description: {
      type: 'string',
      description: 'The new room description text the landlord proposed.',
    },
  },
  required: ['roomId', 'description'],
}

/**
 * Handle a request to edit a room description.
 *
 * IMPORTANT: This handler never persists the description to the rooms
 * table. It only enqueues an admin-queue item (reason: 'edit-description')
 * so a human can review and apply the change. See the file header — never
 * add a rooms.repo.update / write to rooms.description in this function.
 *
 * @param {object} args  { roomId: number, description: string }
 * @param {object} ctx   { lineUserId: string, logger: object }
 * @returns {Promise<{escalated: boolean, roomId: number} | {error: string}>}
 */
export async function handler(args, ctx) {
  const { roomId, description } = args ?? {}
  const log = ctx.logger

  // Basic input guard — the model should always send both, but never trust it.
  if (roomId === undefined || roomId === null ||
      typeof description !== 'string' || !description.trim()) {
    log.warn({ tool: name, lineUserId: ctx.lineUserId, roomId },
      'editRoomDescription: missing or invalid args')
    return { error: 'missing roomId or description' }
  }

  try {
    // SECURITY: do NOT write to rooms.description here. Hand the proposed
    // text to the admin queue verbatim for human review only.
    await create({
      lineUserId:      ctx.lineUserId,
      reason:          'edit-description',
      summary:         `ขอแก้รายละเอียดห้อง ${roomId}`,
      originalPayload: { roomId: args.roomId, description },
    })

    log.info({ tool: name, lineUserId: ctx.lineUserId, roomId },
      'edit-description request escalated to admin queue')

    return { escalated: true, roomId: args.roomId }
  } catch (err) {
    // Unexpected DB failure — surface as a soft error, don't throw.
    log.error({ err, tool: name, lineUserId: ctx.lineUserId, roomId },
      'editRoomDescription handler failed')
    return { error: 'escalation failed' }
  }
}
