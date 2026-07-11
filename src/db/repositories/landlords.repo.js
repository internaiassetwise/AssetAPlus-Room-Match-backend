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

/**
 * Look up a landlord by their Line userId. Used by the .NET chat bot when
 * forwarding actions from chat (list-a-room, edit-description, etc.).
 */
export async function findByLineId(lineUserId) {
  if (!lineUserId) return null
  const { rows } = await query(
    `${SELECT_LANDLORD} WHERE line_id = $1`,
    [lineUserId],
  )
  return rows[0] ? rowToLandlord(rows[0]) : null
}

/**
 * Create a stub landlord row from a Line userId (used by the bot before the
 * admin has captured the landlord's real name/phone). full_name and phone
 * fall back to placeholders that admin can clean up later.
 *
 * Phone is NOT NULL in the schema but we generate a unique value per
 * lineUserId so the row can be inserted without asking the user anything yet.
 */
export async function createFromBot(lineUserId) {
  const stubPhone = `line:${lineUserId}`
  const stubName  = `Line user ${lineUserId.slice(0, 8)}`
  const { rows } = await query(
    `INSERT INTO landlords (full_name, phone, line_id, source)
     VALUES ($1, $2, $3, 'line-bot')
     RETURNING id`,
    [stubName, stubPhone, lineUserId],
  )
  return findById(rows[0].id)
}

/**
 * Capture the Line display name on webapp login. Same rule as tenants: promote
 * the "Line user <id>" bot placeholder to the real Line name, but never clobber
 * a name an admin has already captured (landlords often have their real name +
 * company set by an admin). Landlords have no picture column, so only the name
 * is touched.
 */
export async function refreshFromLine(landlordId, { displayName } = {}) {
  const name = displayName && String(displayName).trim() ? String(displayName).trim() : null
  await query(
    `UPDATE landlords
        SET full_name  = CASE WHEN full_name LIKE 'Line user %' AND $2::text IS NOT NULL
                              THEN $2::text ELSE full_name END,
            updated_at = NOW()
      WHERE id = $1`,
    [landlordId, name],
  )
}
