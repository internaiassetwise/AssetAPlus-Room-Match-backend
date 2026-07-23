// src/db/repositories/rooms.repo.js — DB access for rooms + first image.
import { query } from '../pool.js'
import { rowToRoom } from './_rowToRoom.js'

const SELECT_ROOM = `
  SELECT
    r.id, r.landlord_id, r.zone_id, r.title, r.description, r.property_type,
    r.bedrooms, r.bathrooms, r.size_sqm, r.monthly_rent, r.status,
    to_char(r.available_from, 'YYYY-MM-DD') AS available_from,
    r.lat, r.lng, r.address,
    r.amenities, r.is_featured, r.view_count,
    r.created_at, r.updated_at,
    r.created_by_line_user_id, r.approved_at, r.approved_by,
    r.project_name, r.room_code, r.building, r.floor, r.view_type, r.room_type,
    z.slug AS zone_slug, z.name_th AS zone_name_th,
    (SELECT url FROM room_images WHERE room_id = r.id ORDER BY sort_order LIMIT 1) AS image_url
  FROM rooms r
  JOIN zones z ON z.id = r.zone_id
`

/**
 * List available rooms with optional filters.
 *
 * Filters:
 *   zone, type     — exact match
 *   minRent/maxRent — inclusive range
 *   bounds         — "swLat,swLng,neLat,neLng" map viewport bbox
 *                    (rooms without a lat/lng are excluded when bounds is set)
 */
export async function findAvailable({
  zone, type, roomType, maxRent, minRent, beds, bounds, limit = 50,
} = {}) {
  // Parse bounds — null when missing or malformed.
  let b = null
  if (typeof bounds === 'string' && bounds.includes(',')) {
    const parts = bounds.split(',').map(Number)
    if (parts.length === 4 && parts.every(Number.isFinite)) b = parts
  }
  const { rows } = await query(
    `${SELECT_ROOM}
     WHERE r.status = 'available'
       AND ($1::text IS NULL OR z.slug = $1)
       AND ($2::text IS NULL OR r.property_type = $2)
       AND ($3::text IS NULL OR r.room_type = $3)
       AND ($4::int  IS NULL OR r.monthly_rent <= $4)
       AND ($5::int  IS NULL OR r.monthly_rent >= $5)
       AND ($6::int  IS NULL OR r.bedrooms >= $6)
       AND ($7::text IS NULL OR (
             r.lat BETWEEN $8 AND $10
         AND r.lng BETWEEN $9 AND $11
       ))
     ORDER BY r.is_featured DESC, r.view_count DESC, r.created_at DESC
     LIMIT $12`,
    [
      zone ?? null,            // $1 zone slug
      type ?? null,            // $2 property_type (old: condo/house/etc)
      roomType ?? null,        // $3 room_type (new: STUDIO/1 BEDROOM/etc)
      maxRent ?? null,         // $4
      minRent ?? null,         // $5
      beds ?? null,            // $6 minimum bedrooms (>=)
      b ? 'set' : null,        // $7 bounds sentinel
      b ? b[0] : null,         // $8 swLat
      b ? b[1] : null,         // $9 swLng
      b ? b[2] : null,         // $10 neLat
      b ? b[3] : null,         // $11 neLng
      Math.min(limit, 200),    // $12
    ]
  )
  return rows.map(rowToRoom)
}

export async function findById(id) {
  const { rows } = await query(`${SELECT_ROOM} WHERE r.id = $1`, [id])
  return rows[0] ? rowToRoom(rows[0]) : null
}

export async function bumpViewCount(id) {
  await query(
    'UPDATE rooms SET view_count = view_count + 1, updated_at = NOW() WHERE id = $1',
    [id]
  )
}

/**
 * Insert a new room and return it via findById (which runs the shared SELECT
 * including the primary image + zone join).
 */
export async function create(input) {
  const {
    landlordId, zoneId, title, description = '',
    propertyType, bedrooms, bathrooms, sizeSqm = 0,
    monthlyRent, status = 'available', availableFrom = null,
    amenities = [], isFeatured = false,
    lat = null, lng = null, address = null,
    projectName = null, roomCode = null, building = null,
    floor = null, viewType = null, roomType = null,
  } = input
  const { rows } = await query(
    `INSERT INTO rooms (landlord_id, zone_id, title, description, property_type,
                        bedrooms, bathrooms, size_sqm, monthly_rent, status,
                        available_from, amenities, is_featured,
                        lat, lng, address,
                        project_name, room_code, building, floor, view_type, room_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING id`,
    [
      landlordId, zoneId, title, description, propertyType,
      bedrooms, bathrooms, sizeSqm ?? 0, monthlyRent, status,
      availableFrom, JSON.stringify(amenities), isFeatured,
      lat ?? null, lng ?? null, address ?? null,
      projectName, roomCode, building, floor, viewType, roomType,
    ],
  )
  return findById(rows[0].id)
}

/** Partial update — only the fields provided in `fields` are touched. */
export async function update(id, fields) {
  const cols = []
  const vals = []
  let i = 1
  const map = {
    landlordId:    'landlord_id',
    zoneId:        'zone_id',
    title:         'title',
    description:   'description',
    propertyType:  'property_type',
    bedrooms:      'bedrooms',
    bathrooms:     'bathrooms',
    sizeSqm:       'size_sqm',
    monthlyRent:   'monthly_rent',
    status:        'status',
    availableFrom: 'available_from',
    isFeatured:    'is_featured',
    lat:           'lat',
    lng:           'lng',
    address:       'address',
    projectName:   'project_name',
    roomCode:      'room_code',
    building:      'building',
    floor:         'floor',
    viewType:      'view_type',
    roomType:      'room_type',
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    const col = map[k]
    if (col) { cols.push(`${col} = $${i++}`); vals.push(v) }
  }
  // amenities is JSONB and may arrive as []; explicitly check key presence
  // (vs. just undefined) so admin can clear it by sending [].
  if ('amenities' in fields && fields.amenities !== undefined) {
    cols.push(`amenities = $${i++}::jsonb`)
    vals.push(JSON.stringify(fields.amenities))
  }
  if (!cols.length) return findById(id)
  cols.push('updated_at = NOW()')
  vals.push(id)
  const res = await query(
    `UPDATE rooms SET ${cols.join(', ')} WHERE id = $${i}`,
    vals,
  )
  if (res.rowCount === 0) return null
  return findById(id)
}

export async function remove(id) {
  const res = await query('DELETE FROM rooms WHERE id = $1 RETURNING id', [id])
  return res.rowCount > 0
}

// ─── Landlord-scoped ───────────────────────────────────────────────────
//
// findByLandlord / createForLandlord / updateForLandlord / deleteForLandlord
// enforce landlord ownership so the API can't touch other landlords' rooms.

export async function findByLandlord(landlordId) {
  const { rows } = await query(
    `${SELECT_ROOM}
      WHERE r.landlord_id = $1
      ORDER BY r.created_at DESC`,
    [landlordId],
  )
  return rows.map(rowToRoom)
}

export async function findOneForLandlord(id, landlordId) {
  const { rows } = await query(
    `${SELECT_ROOM} WHERE r.id = $1 AND r.landlord_id = $2`,
    [id, landlordId],
  )
  return rows[0] ? rowToRoom(rows[0]) : null
}

export async function createForLandlord(input) {
  return create({ ...input, landlordId: input.landlordId })
}

export async function updateForLandlord(id, landlordId, fields) {
  // Make sure the landlord actually owns this room before writing.
  const own = await findOneForLandlord(id, landlordId)
  if (!own) return null
  return update(id, fields)
}

export async function deleteForLandlord(id, landlordId) {
  const res = await query(
    'DELETE FROM rooms WHERE id = $1 AND landlord_id = $2 RETURNING id',
    [id, landlordId],
  )
  return res.rowCount > 0
}

// ─── Bot / pending-listing helpers (Phase 4) ────────────────────────────
//
// Landlord drafts created through the Line bot start at status='pending' and
// stay invisible to the webapp until an admin approves them (Phase 5).

/**
 * Create a room with status='pending' on behalf of a landlord. The landlord
 * (find-or-create stub) and zone (numeric id) are resolved upstream by the
 * createRoomDraft tool; this function just inserts. Returns the new room.
 */
export async function createPending({
  landlordId, zoneId, title, description = '', propertyType,
  bedrooms, bathrooms, sizeSqm = 0, monthlyRent, availableFrom = null,
  amenities = [], address = null, lat = null, lng = null,
  createdByLineUserId = null,
}) {
  const { rows } = await query(
    `INSERT INTO rooms (landlord_id, zone_id, title, description, property_type,
                        bedrooms, bathrooms, size_sqm, monthly_rent, status,
                        available_from, amenities, is_featured, lat, lng, address,
                        created_by_line_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11::jsonb,false,$12,$13,$14,$15)
     RETURNING id`,
    [
      landlordId, zoneId, title, description, propertyType,
      bedrooms, bathrooms, sizeSqm ?? 0, monthlyRent,
      availableFrom, JSON.stringify(amenities), lat ?? null, lng ?? null, address ?? null,
      createdByLineUserId ?? null,
    ],
  )
  return findById(rows[0].id)
}

/**
 * Most recent pending draft created by a Line landlord. Used by the image
 * path to attach photos to the draft the landlord just submitted.
 */
export async function findPendingByLineUser(lineUserId) {
  if (!lineUserId) return null
  const { rows } = await query(
    `${SELECT_ROOM}
      WHERE r.created_by_line_user_id = $1 AND r.status = 'pending'
      ORDER BY r.created_at DESC
      LIMIT 1`,
    [lineUserId],
  )
  return rows[0] ? rowToRoom(rows[0]) : null
}

// ─── Admin approval flow (Phase 5) ──────────────────────────────────────

/** All pending listings (bot-submitted, awaiting admin), newest first. */
export async function findPending({ limit = 100 } = {}) {
  const { rows } = await query(
    `${SELECT_ROOM} WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT $1`,
    [Math.min(limit, 200)],
  )
  return rows.map(rowToRoom)
}

/**
 * Approve a pending listing → status='available' + stamp who approved.
 * Returns the refreshed room (with createdByLineUserId for the push) or null
 * if the room isn't pending (already handled / doesn't exist).
 */
export async function approve(id, approver) {
  const { rowCount } = await query(
    `UPDATE rooms
        SET status = 'available', approved_at = NOW(), approved_by = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'pending'`,
    [id, approver],
  )
  if (rowCount === 0) return null
  return findById(id)
}

/** Reject a pending listing → status='removed' (kept for audit, hidden). */
export async function reject(id) {
  const { rowCount } = await query(
    `UPDATE rooms SET status = 'removed', updated_at = NOW()
      WHERE id = $1 AND status = 'pending'`,
    [id],
  )
  if (rowCount === 0) return null
  return findById(id)
}