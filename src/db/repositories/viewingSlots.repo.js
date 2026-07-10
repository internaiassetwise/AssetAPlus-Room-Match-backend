// src/db/repositories/viewingSlots.repo.js — Bookable viewing slots (Phase 6).
//
// Admin opens specific future times for a room; the bot shows them as tappable
// buttons (slotCarousel) and a postback books one. Booking = create a viewing at
// the slot's starts_at + mark the slot 'booked' (so two users can't grab it).

import { query } from '../pool.js'

const COLS = `id, room_id, starts_at, status, booked_viewing_id, created_at`

function shape(r) {
  if (!r) return null
  return {
    id:              r.id,
    roomId:          r.room_id,
    startsAt:        r.starts_at,
    status:          r.status,
    bookedViewingId: r.booked_viewing_id,
    createdAt:       r.created_at,
  }
}

/** Open + future slots for a room, soonest first (what the bot offers). */
export async function openForRoom(roomId) {
  const { rows } = await query(
    `SELECT ${COLS} FROM viewing_slots
      WHERE room_id = $1 AND status = 'open' AND starts_at >= NOW()
      ORDER BY starts_at ASC
      LIMIT 20`,
    [roomId],
  )
  return rows.map(shape)
}

export async function findById(id) {
  const { rows } = await query(`SELECT ${COLS} FROM viewing_slots WHERE id = $1`, [id])
  return shape(rows[0])
}

/** Open a new bookable slot for a room (admin). */
export async function create({ roomId, startsAt }) {
  const { rows } = await query(
    `INSERT INTO viewing_slots (room_id, starts_at)
     VALUES ($1, $2)
     RETURNING ${COLS}`,
    [roomId, startsAt],
  )
  return shape(rows[0])
}

/**
 * Atomically flip an open slot to 'booked' (only if still 'open'). Returns the
 * row on success, null if the slot was gone/already booked — so two near-simultaneous
 * postbacks can't double-book the same slot.
 */
export async function markBooked(id, viewingId) {
  const { rows } = await query(
    `UPDATE viewing_slots
        SET status = 'booked', booked_viewing_id = $2
      WHERE id = $1 AND status = 'open'
      RETURNING ${COLS}`,
    [id, viewingId],
  )
  return shape(rows[0])
}

/** Cancel an open slot (admin). Returns true if a row was updated. */
export async function cancel(id) {
  const { rowCount } = await query(
    `UPDATE viewing_slots SET status = 'cancelled'
      WHERE id = $1 AND status = 'open'`,
    [id],
  )
  return rowCount > 0
}

/**
 * Reopen the slot tied to a viewing — used when an admin declines a request so
 * another tenant can grab that time. Flips a 'booked' slot back to 'open' and
 * clears the booking link. No-op (returns false) if the slot was already
 * cancelled or reassigned, so it's safe to call unconditionally on decline.
 */
export async function reopenByViewing(viewingId) {
  const { rowCount } = await query(
    `UPDATE viewing_slots
        SET status = 'open', booked_viewing_id = NULL
      WHERE booked_viewing_id = $1 AND status = 'booked'`,
    [viewingId],
  )
  return rowCount > 0
}

/** Open future slots across a landlord's rooms (admin view). */
export async function openForLandlord(landlordId) {
  const { rows } = await query(
    `SELECT s.id, s.room_id, s.starts_at, s.status, s.created_at,
            r.title AS room_title
       FROM viewing_slots s
       JOIN rooms r ON r.id = s.room_id
      WHERE r.landlord_id = $1 AND s.status = 'open' AND s.starts_at >= NOW()
      ORDER BY s.starts_at ASC`,
    [landlordId],
  )
  return rows
}
