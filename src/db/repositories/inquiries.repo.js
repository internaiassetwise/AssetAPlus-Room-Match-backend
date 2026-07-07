// src/db/repositories/inquiries.repo.js — Tenant → landlord room inbox.

import { query } from '../pool.js'

const SELECT_BASE = `
  SELECT
    i.id, i.room_id, i.tenant_id, i.message, i.status,
    i.reply, i.replied_at, i.created_at, i.updated_at,
    r.title       AS room_title,
    r.monthly_rent AS room_rent,
    z.slug         AS zone_slug,
    z.name_th      AS zone_name_th,
    (SELECT url FROM room_images WHERE room_id = r.id ORDER BY sort_order LIMIT 1) AS room_image,
    t.full_name    AS tenant_name,
    t.phone        AS tenant_phone,
    t.email        AS tenant_email
  FROM inquiries i
  JOIN rooms   r ON r.id = i.room_id
  JOIN zones   z ON z.id = r.zone_id
  JOIN tenants t ON t.id = i.tenant_id
`

/** Tenant sends a message about a room. */
export async function create({ roomId, tenantId, message }) {
  const { rows } = await query(
    `INSERT INTO inquiries (room_id, tenant_id, message) VALUES ($1, $2, $3) RETURNING id`,
    [roomId, tenantId, message],
  )
  return findById(rows[0].id)
}

/** Single inquiry with all joins. */
export async function findById(id) {
  const { rows } = await query(`${SELECT_BASE} WHERE i.id = $1`, [id])
  return rows[0] || null
}

/** All inquiries across a landlord's rooms (inbox). */
export async function findForLandlord(landlordId, { status } = {}) {
  const { rows } = await query(
    `${SELECT_BASE}
      WHERE r.landlord_id = $1
        AND ($2::text IS NULL OR i.status = $2)
      ORDER BY i.created_at DESC`,
    [landlordId, status ?? null],
  )
  return rows
}

/** All inquiries a tenant has sent. */
export async function findForTenant(tenantId) {
  const { rows } = await query(
    `${SELECT_BASE} WHERE i.tenant_id = $1 ORDER BY i.created_at DESC`,
    [tenantId],
  )
  return rows
}

/** Landlord replies — sets reply + status='replied' + replied_at. */
export async function reply(id, replyText) {
  const { rows } = await query(
    `UPDATE inquiries
        SET reply      = $2,
            status     = 'replied',
            replied_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
     RETURNING id`,
    [id, replyText],
  )
  if (rows.rowCount === 0) return null
  return findById(id)
}

/** Landlord closes an inquiry. */
export async function close(id) {
  const res = await query(
    `UPDATE inquiries SET status = 'closed', updated_at = NOW() WHERE id = $1`,
    [id],
  )
  return res.rowCount > 0
}

/** Count of new inquiries received in the last N days for dashboard. */
export async function countSinceForLandlord(landlordId, days) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n
       FROM inquiries i
       JOIN rooms   r ON r.id = i.room_id
      WHERE r.landlord_id = $1
        AND i.created_at >= NOW() - ($2::int || ' days')::interval`,
    [landlordId, days],
  )
  return rows[0].n
}