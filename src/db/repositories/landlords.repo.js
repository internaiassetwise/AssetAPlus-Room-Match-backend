// src/db/repositories/landlords.repo.js — Landlord CRUD + counts.
import { query } from '../pool.js'

const SELECT_LANDLORD = `
  SELECT
    id, full_name, phone, email, line_id,
    company_name, tax_id, note, source,
    is_active, created_at, updated_at
  FROM landlords
`

export async function list({ isActive, limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT l.*,
            (SELECT COUNT(*) FROM rooms    WHERE landlord_id = l.id)::int              AS room_count,
            (SELECT COUNT(*) FROM rooms    WHERE landlord_id = l.id AND status = 'available')::int AS available_room_count
       FROM landlords l
      WHERE ($1::bool IS NULL OR l.is_active = $1)
      ORDER BY l.created_at DESC
      LIMIT $2`,
    [isActive === undefined ? null : isActive, Math.min(limit, 200)],
  )
  return rows.map(rowToLandlord)
}

export async function findById(id) {
  const { rows } = await query(
    `SELECT l.*,
            (SELECT COUNT(*) FROM rooms    WHERE landlord_id = l.id)::int              AS room_count,
            (SELECT COUNT(*) FROM rooms    WHERE landlord_id = l.id AND status = 'available')::int AS available_room_count,
            (SELECT COUNT(*) FROM matches  m
               JOIN rooms r ON r.id = m.room_id
              WHERE r.landlord_id = l.id AND m.status IN ('suggested','contacted','viewing')
            )::int AS active_match_count
       FROM landlords l
      WHERE l.id = $1`,
    [id],
  )
  return rows[0] ? rowToLandlord(rows[0]) : null
}

export async function update(id, fields) {
  const cols = []
  const vals = []
  let i = 1
  const map = {
    fullName:    'full_name',
    phone:       'phone',
    email:       'email',
    lineId:      'line_id',
    companyName: 'company_name',
    taxId:       'tax_id',
    note:        'note',
    isActive:    'is_active',
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    const col = map[k]
    if (col) { cols.push(`${col} = $${i++}`); vals.push(v) }
  }
  if (!cols.length) return findById(id)
  cols.push(`updated_at = NOW()`)
  vals.push(id)
  const res = await query(
    `UPDATE landlords SET ${cols.join(', ')} WHERE id = $${i}`,
    vals,
  )
  if (res.rowCount === 0) return null
  // Re-fetch via findById so we include room_count + match_count aggregates.
  return findById(id)
}

function rowToLandlord(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    lineId: row.line_id,
    companyName: row.company_name,
    taxId: row.tax_id,
    note: row.note,
    source: row.source,
    isActive: row.is_active,
    roomCount: row.room_count ?? 0,
    availableRoomCount: row.available_room_count ?? 0,
    activeMatchCount: row.active_match_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
