// src/linebot/tools/getRoomDetails.js — Full details of ONE available room.
//
// Tenant-facing read: a user looking at a specific room and asking for its
// price, size, description, amenities, photos, or upcoming viewing slots.
// This tool never exposes rooms that aren't openly listed — pending drafts
// (bot-created, awaiting admin), removed, or otherwise inactive rooms are
// treated exactly like "not found".

import { findById } from "../../db/repositories/rooms.repo.js"
import { findByRoom } from "../../db/repositories/roomImages.repo.js"
import { findForRoomPublic } from "../../db/repositories/viewings.repo.js"

export const name = "getRoomDetails"

// The ONLY text Gemini sees when deciding whether to call this tool, so be
// specific about WHEN to use it vs. the search tool and WHAT it returns.
export const description =
  "Get full details of one available rental room on the Room Match platform by its numeric room id. " +
  "Use this when a tenant asks about a SPECIFIC room they already have the id of — its price, size, " +
  "bedrooms/bathrooms, description, amenities, photos, or available viewing dates. " +
  "Returns the room's title, description, monthly price, beds, baths, size in sqm, zone, address, " +
  "available-from date, amenities list, photo URLs, and upcoming confirmed viewing slots. " +
  "Do NOT use this for browsing or searching rooms; use the room search tool for that."

export const parameters = {
  type: "object",
  properties: {
    roomId: {
      type: "integer",
      description: "Numeric id of the room to fetch details for.",
    },
  },
  required: ["roomId"],
}

/**
 * Load one available room plus its photo gallery and confirmed future viewing
 * slots. Returns a plain object for Gemini to compose the Thai reply from.
 *
 * @param {{ roomId?: number }} args
 * @param {{ lineUserId: string, logger: import("pino").Logger }} ctx
 */
export async function handler(args, ctx) {
  const { logger } = ctx
  const roomId = args?.roomId

  // Invalid id — the schema asks for an integer, but guard anyway so a bad
  // value becomes a polite error instead of a Postgres coerce/throw.
  if (!Number.isInteger(roomId)) {
    return { error: "roomId must be an integer" }
  }

  try {
    const room = await findById(roomId)

    // SECURITY: only "available" rooms are visible to tenants. Pending
    // (bot-created, awaiting admin), removed, or inactive rooms must never
    // leak — respond exactly as if the room didn't exist.
    if (!room || room.status !== "available") {
      logger.info({ tool: name, roomId, status: room?.status ?? null },
        "room not found or not available")
      return { error: "room not found or not available" }
    }

    // Photo gallery + upcoming confirmed viewings. findByRoom returns the
    // gallery sorted; findForRoomPublic returns confirmed-future slots ASC.
    const photos = (await findByRoom(roomId)).map((p) => p.url)
    // viewings rows use the snake_case `scheduled_for` key (no alias in the repo).
    const viewingSlots = (await findForRoomPublic(roomId))
      .map((s) => s.scheduled_for)

    logger.info(
      { tool: name, roomId, photoCount: photos.length, slotCount: viewingSlots.length },
      "room details fetched",
    )

    // `address` isn't exposed by the current room mapper, so coalesce to null
    // rather than letting the key vanish from the JSON Gemini receives.
    return {
      room: {
        id:            room.id,
        title:         room.title,
        description:   room.description,
        price:         room.price,
        beds:          room.beds,
        baths:         room.baths,
        sqm:           room.sqm,
        zone:          room.zone,
        address:       room.address ?? null,
        availableFrom: room.availableFrom,
        amenities:     room.amenities,
      },
      photos,
      viewingSlots,
    }
  } catch (err) {
    // Unexpected DB failure — log with context and return a soft error so the
    // model can relay a polite Thai fallback instead of crashing the turn.
    logger.error({ tool: name, roomId, err }, "getRoomDetails failed")
    return { error: "failed to load room details" }
  }
}
