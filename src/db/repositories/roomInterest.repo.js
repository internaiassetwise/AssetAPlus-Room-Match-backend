// src/db/repositories/roomInterest.repo.js — "which room were they looking at?"
//
// Written when a customer messages us from a room page (the CTA opens LINE with
// a pre-filled question that names the room). Read by the admin inbox, so
// whoever picks the chat up already knows what it is about, and by the bot, so
// "ห้องนี้ว่างไหม" resolves to the right room instead of a clarifying question.
//
// Append-only on purpose: a person comparing three rooms produces three rows,
// and that sequence is more useful than a single overwritten "current room".

import { query } from '../pool.js'

/** Record that this LINE user just asked about this room. Best-effort. */
export async function record({ lineUserId, roomId, source = 'web-cta' }) {
  if (!lineUserId || !roomId) return null
  const { rows } = await query(
    `INSERT INTO room_interest (line_user_id, room_id, source)
     VALUES ($1, $2, $3)
     RETURNING id, line_user_id, room_id, source, created_at`,
    [lineUserId, roomId, source],
  )
  return rows[0] ?? null
}

/**
 * The room this person most recently asked about, with enough detail to show
 * in the inbox. Null when they've never come in from a room page.
 */
export async function latestForUser(lineUserId, { withinMinutes } = {}) {
  if (!lineUserId) return null
  const { rows } = await query(
    `SELECT i.room_id, i.source, i.created_at,
            r.title, r.room_code, r.monthly_rent, r.status,
            z.name_th AS zone
       FROM room_interest i
       JOIN rooms r ON r.id = i.room_id
       LEFT JOIN zones z ON z.id = r.zone_id
      WHERE i.line_user_id = $1
        AND ($2::int IS NULL OR i.created_at > NOW() - ($2 || ' minutes')::interval)
      ORDER BY i.created_at DESC
      LIMIT 1`,
    [lineUserId, withinMinutes ?? null],
  )
  const r = rows[0]
  if (!r) return null
  return {
    roomId:      r.room_id,
    title:       r.title,
    roomCode:    r.room_code,
    monthlyRent: r.monthly_rent,
    status:      r.status,
    zone:        r.zone,
    source:      r.source,
    askedAt:     r.created_at,
  }
}

/**
 * Every room this person has asked about, newest first.
 *
 * The inbox needs the LIST, not just the latest: someone comparing three rooms
 * produces three entries, and the transcript shows three near-identical cards
 * whose customer-facing labels are masked. Without the times and full room
 * numbers here, "which room are they talking about" is unanswerable once more
 * than one is involved.
 */
export async function recentForUser(lineUserId, { limit = 8 } = {}) {
  if (!lineUserId) return []
  const { rows } = await query(
    `SELECT DISTINCT ON (i.room_id)
            i.room_id, i.created_at,
            r.title, r.room_code, r.monthly_rent, r.status,
            z.name_th AS zone
       FROM room_interest i
       JOIN rooms r ON r.id = i.room_id
       LEFT JOIN zones z ON z.id = r.zone_id
      WHERE i.line_user_id = $1
      ORDER BY i.room_id, i.created_at DESC`,
    [lineUserId],
  )
  return rows
    .map((r) => ({
      roomId: r.room_id, title: r.title, roomCode: r.room_code,
      monthlyRent: r.monthly_rent, status: r.status, zone: r.zone,
      askedAt: r.created_at,
    }))
    // DISTINCT ON forces ordering by room_id first, so sort by time here.
    .sort((a, b) => new Date(b.askedAt) - new Date(a.askedAt))
    .slice(0, limit)
}

/** Interest counts per room, most-asked first — feeds the admin dashboard. */
export async function countsByRoom({ limit = 20, sinceDays = 30 } = {}) {
  const { rows } = await query(
    `SELECT i.room_id, COUNT(*)::int AS asks,
            COUNT(DISTINCT i.line_user_id)::int AS people,
            MAX(i.created_at) AS last_asked,
            r.title, r.room_code
       FROM room_interest i
       JOIN rooms r ON r.id = i.room_id
      WHERE i.created_at > NOW() - ($2 || ' days')::interval
      GROUP BY i.room_id, r.title, r.room_code
      ORDER BY people DESC, asks DESC
      LIMIT $1`,
    [Math.min(limit, 100), String(sinceDays)],
  )
  return rows.map((r) => ({
    roomId: r.room_id, title: r.title, roomCode: r.room_code,
    asks: r.asks, people: r.people, lastAsked: r.last_asked,
  }))
}
