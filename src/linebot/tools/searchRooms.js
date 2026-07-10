// src/linebot/tools/searchRooms.js — Let a TENANT find available rooms by criteria.
//
// One of the Phase 4 Gemini function-calling tools. The agent loop (in
// chatAgent.service.js) exposes this to Gemini via the AGENT_TOOLS registry;
// when the model calls `searchRooms`, it dispatches here and feeds the returned
// object back as the functionResponse so the model can compose a Thai reply.
//
// The tenant-facing search path: location → zone slug (zones.repo.findByName),
// then rooms.repo.findAvailable with the rest of the filters. We never throw on
// normal outcomes (no zone match, zero results) — those are data, surfaced as
// { count, rooms, zoneMatched } for the model to phrase. Only genuinely invalid
// input or an unexpected DB failure return { error }.

import { findByName } from '../../db/repositories/zones.repo.js'
import { findAvailable } from '../../db/repositories/rooms.repo.js'
import { roomCarousel } from '../flexMessages.js'

export const name = 'searchRooms'

// CRITICAL: this description is the ONLY text Gemini uses to decide WHEN to
// call this tool, so be specific about the trigger and the payload.
export const description =
  'Search for available rental rooms on the Room Match platform for a tenant looking for a place to rent. ' +
  'Call this whenever a tenant wants to find, see, look at, browse, or view available rooms — INCLUDING vague ' +
  'requests that give NO specific criteria (e.g. "ขอดูห้องว่าง", "มีห้องอะไรบ้าง", "อยากดูห้อง", "show me rooms", ' +
  '"ดูห้องเช่าหน่อย"): in that case call it with NO arguments and it returns up to 5 currently-available rooms ' +
  'to browse, plus a Flex card carousel the user can tap. Do NOT ask the tenant for criteria first when they ' +
  'just want to see what is available — show rooms right away; they can narrow down afterwards. ' +
  'When the tenant DOES mention criteria, filter by location or area (Thai or English, e.g. "พญาไท", "Ari"), ' +
  'monthly rent price range, minimum number of bedrooms, and property type (condo, house, townhouse, ' +
  'apartment, studio). ' +
  'Returns up to 5 matching available rooms, each with id, title, monthly price, beds, baths, size in sqm, ' +
  'zone, and image — or an empty list when nothing matches. ' +
  'Do NOT use this for landlords posting a listing, booking a viewing, or asking about a specific room by id.'

// Gemini fills these args; every filter is optional so the model can search
// with whatever the tenant mentioned (e.g. price-only, or area-only).
export const parameters = {
  type: 'object',
  properties: {
    location: {
      type: 'string',
      description: 'Free-text area or zone name in Thai or English (e.g. "พญาไท", "Ari", "sathorn").',
    },
    minPrice: {
      type: 'number',
      description: 'Minimum monthly rent in THB (inclusive).',
    },
    maxPrice: {
      type: 'number',
      description: 'Maximum monthly rent in THB (inclusive).',
    },
    beds: {
      type: 'integer',
      description: 'Minimum number of bedrooms (inclusive, >=).',
    },
    propertyType: {
      type: 'string',
      enum: ['condo', 'house', 'townhouse', 'apartment', 'studio'],
      description: 'Property type to filter by.',
    },
  },
  required: [],
}

/**
 * Run the room search for a tenant.
 *
 * @param {object} args     The Gemini-supplied args (all optional).
 * @param {object} ctx      { lineUserId, logger }.
 * @returns {Promise<object>}  Plain object for Gemini's functionResponse.
 */
export async function handler(args, ctx) {
  const { location, minPrice, maxPrice, beds, propertyType } = args || {}
  const log = ctx?.logger

  // A contradictory price range (min > max) can never match a room, so flag it
  // as a soft error rather than silently returning an empty list — the model
  // can then ask the tenant to clarify.
  if (minPrice != null && maxPrice != null && Number(minPrice) > Number(maxPrice)) {
    log?.warn({ tool: name, minPrice, maxPrice }, 'searchRooms rejected: minPrice exceeds maxPrice')
    return { error: 'ราคาต่ำสุดสูงกว่าราคาสูงสุด' }
  }

  // Resolve a free-text location to a zone slug (matches Thai name, English
  // name, or slug). Best-effort: if the lookup itself blows up we fall back to
  // searching every zone rather than failing the whole search.
  let zoneSlug = null
  let zone = null
  if (location) {
    try {
      zone = await findByName(location)
    } catch (err) {
      log?.error({ tool: name, err, location }, 'zone lookup failed — searching all zones')
    }
    zoneSlug = zone?.slug ?? null
  }

  let rooms = []
  try {
    rooms = await findAvailable({
      zone: zoneSlug,
      type: propertyType,
      minRent: minPrice,
      maxRent: maxPrice,
      beds,
      limit: 5,
    })
  } catch (err) {
    // Unexpected DB failure — prefer returning { error } over throwing; the
    // dispatcher would catch a throw anyway, but this keeps the diagnostics here.
    log?.error({ tool: name, err, zoneSlug, propertyType, minPrice, maxPrice, beds }, 'findAvailable failed')
    return { error: 'ค้นหาห้องไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' }
  }

  log?.info(
    { tool: name, location, zoneSlug, propertyType, minPrice, maxPrice, beds, count: rooms.length },
    'searchRooms ok',
  )

  // Always return the same shape, even with zero results — an empty list is
  // normal data (the model says "ไม่พบห้องที่ตรง"), not an error. zoneMatched
  // is null when no location was given, false when one was given but didn't
  // resolve, so the model can mention the area wasn't recognised.
  return {
    count: rooms.length,
    rooms: rooms.map((r) => ({
      id: r.id,
      title: r.title,
      price: r.price,
      beds: r.beds,
      baths: r.baths,
      sqm: r.sqm,
      zone: r.zone,
      image: r.image,
    })),
    zoneMatched: location ? Boolean(zone) : null,
    // Push a Flex carousel of the (full) room objects so the tenant sees cards.
    // The agent loop strips _push before forwarding the result to Gemini.
    _push: rooms.length ? [roomCarousel(rooms)] : [],
  }
}
