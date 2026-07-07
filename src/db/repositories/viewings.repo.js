// src/db/repositories/viewings.repo.js — DB access for viewings (วันนัดชมห้อง).
//
// All status filters use the CHECK-constrained set: requested | confirmed |
// declined | completed | cancelled.

import { query } from '../pool.js'

const SELECT_BASE = `
  SELECT
    v.id, v.room_id, v.tenant_id, v.scheduled_for,
    v.status, v.note, v.landlord_note,
    v.requested_at, v.created_at, v.updated_at,
    r.title       AS room_title,
    r.monthly_rent AS room_rent,
    z.slug         AS zone_slug,
    z.name_th      AS zone_name_th,
    (SELECT url FROM room_images WHERE room_id = r.id ORDER BY sort_order LIMIT 1) AS room_image,
    t.full_name    AS tenant_name,
    t.phone        AS tenant_phone,
    t.email        AS tenant_email
  FROM viewings v
  JOIN rooms    r ON r.id = v.room_id
  JOIN zones    z ON z.id = r.zone_id
  JOIN tenants  t ON t.id = v.tenant_id
`

/** Create a new viewing request from a tenant. */
export async function createRequest({ roomId, tenantId, scheduledFor, note }) {
  const { rows } = await query(
    `INSERT INTO viewings (room_id, tenant_id, scheduled_for, note)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [roomId, tenantId, scheduledFor, note ?? null],
  )
  return findById(rows[0].id)
}

/** Fetch a single viewing with all joins. */
export async function findById(id) {
  const { rows } = await query(`${SELECT_BASE} WHERE v.id = $1`, [id])
  return rows[0] || null
}

/** All viewings for one tenant (own requests + scheduled). */
export async function findForTenant(tenantId, { status } = {}) {
  const { rows } = await query(
    `${SELECT_BASE}
      WHERE v.tenant_id = $1
        AND ($2::text IS NULL OR v.status = $2)
      ORDER BY v.scheduled_for DESC`,
    [tenantId, status ?? null],
  )
  return rows
}

/** All viewings across a landlord's rooms. */
export async function findForLandlord(landlordId, { status } = {}) {
  const { rows } = await query(
    `${SELECT_BASE}
      WHERE r.landlord_id = $1
        AND ($2::text IS NULL OR v.status = $2)
      ORDER BY v.scheduled_for DESC`,
    [landlordId, status ?? null],
  )
  return rows
}

/**
 * Update status (and optionally landlord_note). Returns the refreshed row.
 * Caller is responsible for authorization (landlord confirm/decline, tenant
 * cancel) — this repo just runs the UPDATE.
 */
export async function updateStatus(id, { status, landlordNote, note }) {
  const cols = []
  const vals = []
  let i = 1
  if (status !== undefined)     { cols.push(`status = $${i++}`);       vals.push(status) }
  if (landlordNote !== undefined){ cols.push(`landlord_note = $${i++}`); vals.push(landlordNote) }
  if (note !== undefined)        { cols.push(`note = $${i++}`);          vals.push(note) }
  if (!cols.length) return findById(id)
  cols.push('updated_at = NOW()')
  vals.push(id)
  const res = await query(
    `UPDATE viewings SET ${cols.join(', ')} WHERE id = $${i}`,
    vals,
  )
  if (res.rowCount === 0) return null
  return findById(id)
}

/** Count of upcoming (confirmed) viewings for the landlord's dashboard tile. */
export async function countUpcomingForLandlord(landlordId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n
       FROM viewings v
       JOIN rooms    r ON r.id = v.room_id
      WHERE r.landlord_id = $1
        AND v.status = 'confirmed'
        AND v.scheduled_for >= NOW()`,
    [landlordId],
  )
  return rows[0].n
}