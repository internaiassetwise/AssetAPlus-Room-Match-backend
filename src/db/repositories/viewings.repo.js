// src/db/repositories/viewings.repo.js — DB access for viewings (วันนัดชมห้อง).
//
// All status filters use the CHECK-constrained set: requested | confirmed |
// declined | completed | cancelled.

import { query } from '../pool.js'

const SELECT_BASE = `
  SELECT
    v.id, v.room_id, v.tenant_id, v.tenant_line_user_id, v.scheduled_for,
    v.status, v.note, v.landlord_note,
    v.requested_at, v.created_at, v.updated_at,
    r.landlord_id,
    r.title       AS room_title,
    r.monthly_rent AS room_rent,
    z.slug         AS zone_slug,
    z.name_th      AS zone_name_th,
    (SELECT url FROM room_images WHERE room_id = r.id ORDER BY sort_order LIMIT 1) AS room_image,
    t.full_name    AS tenant_name,
    t.phone        AS tenant_phone,
    t.email        AS tenant_email,
    t.line_id      AS tenant_line_id
  FROM viewings v
  JOIN rooms    r ON r.id = v.room_id
  JOIN zones    z ON z.id = r.zone_id
  JOIN tenants  t ON t.id = v.tenant_id
`

/**
 * Create a viewing on behalf of a Line tenant. We cache tenant_line_user_id
 * at write-time so the bot's confirm-viewing endpoint can find the Line
 * user id even if the tenants row is later anonymised.
 */
export async function createForTenant({ roomId, tenantId, tenantLineUserId, scheduledFor, note }) {
  const { rows } = await query(
    `INSERT INTO viewings (room_id, tenant_id, tenant_line_user_id, scheduled_for, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [roomId, tenantId, tenantLineUserId ?? '', scheduledFor, note ?? null],
  )
  return findById(rows[0].id)
}

/**
 * Admin books a viewing directly for a tenant (e.g. the tenant asked admin over
 * the phone/Line to set it up). Defaults to status='confirmed' — admin is
 * arranging it on the tenant's behalf, not requesting it — and backfills the
 * cached tenant_line_user_id from the tenants row so reminders + confirmations
 * can push without an extra lookup.
 */
export async function createForAdmin({ roomId, tenantId, scheduledFor, note, status = 'confirmed' }) {
  const { rows } = await query(
    `INSERT INTO viewings (room_id, tenant_id, tenant_line_user_id, scheduled_for, note, status)
     VALUES ($1, $2, COALESCE((SELECT line_id FROM tenants WHERE id = $2), ''), $3, $4, $5)
     RETURNING id`,
    [roomId, tenantId, scheduledFor, note ?? null, status],
  )
  return findById(rows[0].id)
}

/** Legacy alias kept for any older callers. */
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
 * All viewings, for the admin confirmation screen. Optional status filter
 * (null = every status); defaults to 'requested' (pending confirmations).
 * Requested viewings float to the top, then soonest-scheduled first.
 */
export async function findForAdmin({ status = 'requested' } = {}) {
  const { rows } = await query(
    `${SELECT_BASE}
      WHERE ($1::text IS NULL OR v.status = $1)
      ORDER BY
        CASE v.status WHEN 'requested' THEN 0 ELSE 1 END,
        v.scheduled_for ASC`,
    [status ?? null],
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

/**
 * Atomically CLAIM the viewings that are due for a reminder in one window and
 * stamp them as sent, returning the claimed rows (with room title) so the caller
 * can push the LINE message. Doing the claim in a single UPDATE…RETURNING makes
 * it safe under restarts and multiple app instances — each viewing is claimed by
 * exactly one caller, so no reminder is sent twice.
 *
 * Only CONFIRMED viewings are reminded — a tenant doesn't have a locked-in
 * appointment until admin confirms, so we never remind a still-'requested' (or
 * declined/cancelled/completed) one. Tenants with no LINE id are skipped.
 * Windows:
 *   '24h' → scheduled 2h..24h from now  (the "you have a viewing" heads-up)
 *   '2h'  → scheduled 0..2h  from now    (the "it's almost time" nudge)
 * The 24h window stops at 2h so a viewing confirmed <2h out only gets the 2h
 * nudge, never both at once.
 *
 * @param {'24h'|'2h'} windowKind
 * @returns {Promise<Array<{id:number, room_id:number, tenant_line_user_id:string, scheduled_for:string, room_title:string}>>}
 */
export async function claimDueViewingReminders(windowKind) {
  // Fixed switch (never user input) → safe to interpolate into the SQL.
  const col = windowKind === '2h' ? 'reminder_2h_sent_at' : 'reminder_24h_sent_at'
  const bounds = windowKind === '2h'
    ? "v.scheduled_for > NOW() AND v.scheduled_for <= NOW() + interval '2 hours'"
    : "v.scheduled_for > NOW() + interval '2 hours' AND v.scheduled_for <= NOW() + interval '24 hours'"
  const { rows } = await query(
    `WITH due AS (
       UPDATE viewings v
          SET ${col} = NOW(), updated_at = NOW()
        WHERE v.status = 'confirmed'
          AND v.${col} IS NULL
          AND v.tenant_line_user_id <> ''
          AND ${bounds}
        RETURNING v.id, v.room_id, v.tenant_line_user_id, v.scheduled_for
     )
     SELECT d.id, d.room_id, d.tenant_line_user_id, d.scheduled_for, r.title AS room_title
       FROM due d
       JOIN rooms r ON r.id = d.room_id`,
  )
  return rows
}

/**
 * Public read of confirmed + future viewings for a single room. Used by the
 * RoomDetail page's <AvailableViewingDates> so anyone (signed in or not)
 * browsing the room can see the dates admin has set.
 *
 * SECURITY: this feeds an UNAUTHENTICATED route (GET /api/viewings?roomId=&public=1),
 * so it MUST NOT select tenant PII (name/phone/email/line_id) or notes. It uses
 * a dedicated minimal SELECT — never SELECT_BASE, which joins tenant contact
 * columns. Callers still map to a whitelist before responding (defense in depth).
 */
export async function findForRoomPublic(roomId) {
  const { rows } = await query(
    `SELECT v.id, v.scheduled_for, v.status
       FROM viewings v
      WHERE v.room_id = $1
        AND v.status = 'confirmed'
        AND v.scheduled_for >= NOW()
      ORDER BY v.scheduled_for ASC`,
    [roomId],
  )
  return rows
}