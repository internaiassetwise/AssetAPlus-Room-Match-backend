// src/db/repositories/landlords.repo.js — Landlord CRUD + counts.
import { query, pool } from '../pool.js'

const SELECT_LANDLORD = `
  SELECT
    id, full_name, phone, email, line_id,
    company_name, tax_id, note, source,
    contact_name, contact_phone, contact_relation,
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

/**
 * Create a landlord from admin-entered data. Used to onboard the pre-webapp
 * ("legacy") owners whose rooms were deposited before this platform existed:
 * admin captures name + phone now; line_id is usually NULL because the LINE
 * identity is not known at intake time (it is bound later — see
 * docs/LEGACY_LANDLORD_ONBOARDING.md). Defaults source to 'legacy' so these
 * rows are distinguishable from 'line-bot' stubs and 'website' signups.
 */
export async function create(fields) {
  const {
    fullName,
    phone,
    email = null,
    lineId = null,
    companyName = null,
    taxId = null,
    note = null,
    source = 'legacy',
    // Who to actually call. Blank = the owner is their own contact.
    contactName = null,
    contactPhone = null,
    contactRelation = null,
  } = fields
  const { rows } = await query(
    `INSERT INTO landlords (full_name, phone, email, line_id, company_name, tax_id, note, source,
                            contact_name, contact_phone, contact_relation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [fullName, phone, email, lineId, companyName, taxId, note, source,
     contactName, contactPhone, contactRelation],
  )
  return findById(rows[0].id)
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
    note:            'note',
    isActive:        'is_active',
    contactName:     'contact_name',
    contactPhone:    'contact_phone',
    contactRelation: 'contact_relation',
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

/** Hard-delete a landlord. Callers must ensure the landlord owns no rooms first
 *  (rooms FK is ON DELETE CASCADE — deleting would take the rooms with it). */
export async function remove(id) {
  const { rowCount } = await query('DELETE FROM landlords WHERE id = $1', [id])
  return rowCount > 0
}

/**
 * Bind a landlord row to a LINE identity when a claim link is redeemed, merging
 * away any OTHER landlord that already held that line_id (typically a bot stub
 * created when the owner messaged the bot before claiming). In one transaction:
 * move the stub's rooms/preferences to the target, release the stub's line_id +
 * deactivate it, then set line_id on the target. Idempotent if the target is the
 * one that already held the identity. Returns the target (via findById).
 */
export async function bindLineIdWithMerge(targetId, lineUserId) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: dupes } = await client.query(
      'SELECT id FROM landlords WHERE line_id = $1 AND id <> $2', [lineUserId, targetId],
    )
    for (const d of dupes) {
      await client.query('UPDATE rooms SET landlord_id = $1 WHERE landlord_id = $2', [targetId, d.id])
      await client.query('UPDATE preferences SET landlord_id = $1 WHERE landlord_id = $2', [targetId, d.id])
      await client.query(
        'UPDATE landlords SET line_id = NULL, is_active = FALSE, updated_at = NOW() WHERE id = $1', [d.id],
      )
    }
    await client.query(
      'UPDATE landlords SET line_id = $2, is_active = TRUE, updated_at = NOW() WHERE id = $1',
      [targetId, lineUserId],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  return findById(targetId)
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
    contactName: row.contact_name ?? null,
    contactPhone: row.contact_phone ?? null,
    contactRelation: row.contact_relation ?? null,
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
