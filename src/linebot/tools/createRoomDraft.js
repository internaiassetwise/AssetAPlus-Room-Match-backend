// src/linebot/tools/createRoomDraft.js — Landlord "list my room" tool.
//
// Called when a landlord tells the bot they want to list a room for rent on
// Room Match. We find-or-create a stub landlord row from their Line userId,
// resolve the free-text zone to a numeric id, then insert the room at
// status='pending'. Pending rooms are invisible to tenants until an admin
// approves them in the webapp (Phase 5), so nothing the landlord submits via
// chat goes live unreviewed.

import { config } from '../../config.js'
import { findByLineId, createFromBot } from '../../db/repositories/landlords.repo.js'
import { findByName, findAll } from '../../db/repositories/zones.repo.js'
import { createPending } from '../../db/repositories/rooms.repo.js'
import { listingFormCard, pendingListing } from '../flexMessages.js'

export const name = 'createRoomDraft'

export const description =
  'Use when a landlord (room owner / lister) wants to list, post, or submit a ' +
  'room for rent on the Room Match rental platform. push a fillable form (LIFF) ' +
  'the landlord opens inside Line; call with no arguments; if the form is not ' +
  'configured, fall back to collecting details from chat.'

// The LIFF form (when configured) collects every field, so the model needs to
// supply nothing. When the form is NOT configured the handler still falls back
// to extracting fields from chat — but the parameters schema stays empty and
// the model is told (via the system prompt) to just call createRoomDraft.
export const parameters = {
  type: 'object',
  properties: {},
  required: [],
}

/**
 * Create a pending room draft for the landlord behind ctx.lineUserId.
 *
 * Soft failures (missing fields, unrecognised zone) return { error } so the
 * model can relay/handle them; the dispatcher catches any thrown error.
 *
 * @returns {Promise<object>} { roomId, title, status, _push } on success, or
 *   { error } for an expected failure.
 */
export async function handler(args, ctx) {
  const log = ctx.logger.child({ tool: name, lineUserId: ctx.lineUserId })

  // 0. LIFF form path (Feature C). When the listing form is configured, push a
  //    Flex card the landlord taps to fill the form inside Line — it submits to
  //    /api/liff/listing/submit and creates the pending room itself. The model
  //    does not need to (and should not) extract any fields in this mode.
  if (config.LIFF_LISTING_ID) {
    log.info({ liffId: config.LIFF_LISTING_ID }, 'createRoomDraft pushing LIFF form')
    return {
      mode: 'form',
      _push: [listingFormCard(config.LIFF_LISTING_ID)],
    }
  }

  // 1. Defensive backstop — Gemini is told these are required, but a stray
  //    call can still omit one. Check the trio the listing genuinely can't
  //    exist without (zone is validated separately below).
  if (!args.title || args.monthlyRent == null || args.beds == null || args.baths == null) {
    log.warn({ args }, 'createRoomDraft rejected: missing required fields')
    return { error: 'missing required fields (title, monthlyRent, beds, baths)' }
  }

  // 2. Find-or-create the landlord from their Line userId. A first-time
  //    lister won't have a row yet, so we drop a stub the admin can tidy up.
  let landlord = await findByLineId(ctx.lineUserId)
  if (!landlord) {
    landlord = await createFromBot(ctx.lineUserId)
    log.info({ landlordId: landlord.id }, 'created stub landlord for new lister')
  }

  // 3. Resolve the free-text zone. If nothing matches, hand back the list of
  //    known zones (Thai names) so the model can suggest a valid one.
  const zone = await findByName(args.zone)
  if (!zone) {
    const all = await findAll()
    log.warn({ zone: args.zone }, 'createRoomDraft rejected: unknown zone')
    return {
      error: 'unknown zone',
      zone: args.zone,
      availableZones: all.map((z) => z.name_th),
    }
  }

  // 4. Insert at status='pending'. Default propertyType→condo, sizeSqm→0,
  //    amenities→[] to match the column NOT NULL / JSONB expectations.
  const room = await createPending({
    landlordId: landlord.id,
    zoneId: zone.id,
    title: args.title,
    description: args.description ?? '',
    propertyType: args.propertyType ?? 'condo',
    bedrooms: args.beds,
    bathrooms: args.baths,
    sizeSqm: args.sqm ?? 0,
    monthlyRent: args.monthlyRent,
    availableFrom: args.availableFrom || null,
    amenities: args.amenities ?? [],
    address: args.address ?? null,
    createdByLineUserId: ctx.lineUserId,
  })

  log.info({ roomId: room.id, zoneId: zone.id, monthlyRent: args.monthlyRent }, 'pending room draft created')

  // 5. Return the id + title + pending status. _push is a private key the
  //    agent loop strips before forwarding the result to Gemini, so it does
  //    not leak into the model-visible data.
  return {
    roomId: room.id,
    title: args.title,
    status: 'pending',
    _push: [pendingListing({ title: args.title, roomId: room.id })],
  }
}
