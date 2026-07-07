// src/db/repositories/dashboard.repo.js — Aggregate KPI queries for /api/dashboard.

import { query } from '../pool.js'

/** Total rooms belonging to landlord (any status). */
export async function countRooms(landlordId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS n FROM rooms WHERE landlord_id = $1',
    [landlordId],
  )
  return rows[0].n
}

/** Rooms by status — used for "available" tile + occupancy calc. */
export async function countByStatus(landlordId, status) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS n FROM rooms WHERE landlord_id = $1 AND status = $2',
    [landlordId, status],
  )
  return rows[0].n
}

/** Fraction (0..1) of landlord rooms that are reserved/matched (occupied). */
export async function occupancyRate(landlordId) {
  const { rows } = await query(
    `SELECT
       COUNT(*)::int                                          AS total,
       COUNT(*) FILTER (WHERE status IN ('reserved','matched'))::int AS occupied
     FROM rooms WHERE landlord_id = $1`,
    [landlordId],
  )
  const { total, occupied } = rows[0]
  return total > 0 ? Math.round((occupied / total) * 100) : 0
}

/** Recent inquiry rows for the activity feed. */
export async function recentInquiries(landlordId, limit = 5) {
  const { rows } = await query(
    `SELECT i.id, i.message, i.status, i.created_at,
            r.title AS room_title,
            t.full_name AS tenant_name
       FROM inquiries i
       JOIN rooms    r ON r.id = i.room_id
       JOIN tenants  t ON t.id = i.tenant_id
      WHERE r.landlord_id = $1
      ORDER BY i.created_at DESC
      LIMIT $2`,
    [landlordId, limit],
  )
  return rows
}

/** Recent viewing rows for the activity feed. */
export async function recentViewings(landlordId, limit = 5) {
  const { rows } = await query(
    `SELECT v.id, v.scheduled_for, v.status, v.note, v.landlord_note,
            r.title  AS room_title,
            t.full_name AS tenant_name
       FROM viewings v
       JOIN rooms    r ON r.id = v.room_id
       JOIN tenants  t ON t.id = v.tenant_id
      WHERE r.landlord_id = $1
      ORDER BY v.scheduled_for DESC
      LIMIT $2`,
    [landlordId, limit],
  )
  return rows
}