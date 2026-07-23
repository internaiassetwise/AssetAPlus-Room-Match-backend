// src/db/repositories/matches.repo.js — DB access for tenant ⇄ room pairings.
//
// Scoring (used by suggestForTenant):
//   zone match           30
//   property_type match  20
//   bedrooms in range    20  (uses min_bedrooms..max_bedrooms from tenant preferences)
//   rent within range    30
// Total = 100
import { query } from '../pool.js'

const SELECT_MATCH = `
  SELECT
    m.id, m.tenant_id, m.room_id, m.status, m.match_score, m.agent_note,
    m.created_at, m.updated_at,
    t.full_name AS tenant_name, t.phone AS tenant_phone,
    r.title AS room_title, r.monthly_rent AS room_rent,
    r.bedrooms AS room_bedrooms, r.property_type AS room_type,
    z.name_th AS zone_name, z.slug AS zone_slug
  FROM matches m
  JOIN tenants t ON t.id = m.tenant_id
  JOIN rooms   r ON r.id = m.room_id
  JOIN zones   z ON z.id = r.zone_id
`

export async function list({ status, tenantId, roomId, limit = 50 } = {}) {
  const { rows } = await query(
    `${SELECT_MATCH}
     WHERE ($1::text IS NULL OR m.status = $1)
       AND ($2::int  IS NULL OR m.tenant_id = $2)
       AND ($3::int  IS NULL OR m.room_id   = $3)
     ORDER BY m.match_score DESC NULLS LAST, m.created_at DESC
     LIMIT $4`,
    [status ?? null, tenantId ?? null, roomId ?? null, Math.min(limit, 200)],
  )
  return rows.map(rowToMatch)
}

export async function create({ tenantId, roomId, status = 'suggested', matchScore = null, agentNote = null }) {
  const { rows } = await query(
    `INSERT INTO matches (tenant_id, room_id, status, match_score, agent_note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, room_id) DO UPDATE
       SET status      = EXCLUDED.status,
           match_score = EXCLUDED.match_score,
           updated_at  = NOW()
     RETURNING id`,
    [tenantId, roomId, status, matchScore, agentNote],
  )
  return rows[0].id
}

export async function updateStatus(id, status, agentNote = null) {
  const { rows } = await query(
    `UPDATE matches
        SET status     = $2,
            agent_note = COALESCE($3, agent_note),
            updated_at = NOW()
      WHERE id = $1
      RETURNING id`,
    [id, status, agentNote],
  )
  return rows[0] || null
}

/**
 * Stamp the room's denormalised `matched_at` whenever a match reaches the
 * signed-lifecycle terminal state. Source of truth stays in `matches`; this
 * just keeps the landing-page stat query (`COUNT(*) FROM rooms WHERE
 * matched_at IS NOT NULL`) cheap and accurate.
 *
 * Idempotent — uses COALESCE-equivalent semantics so a re-transition (e.g.
 * admin toggles contact_signed → contract_signed twice) keeps the earliest
 * timestamp, never overwrites a real signed moment, and is a no-op when the
 * destination status isn't `contract_signed`.
 *
 * Returns the room id that was stamped (or null).
 */
export async function markRoomMatched(matchId) {
  const { rows } = await query(
    `WITH src AS (
       SELECT m.id, m.room_id, m.updated_at
         FROM matches m
        WHERE m.id = $1 AND m.status = 'contract_signed'
     )
     UPDATE rooms r
        SET matched_at = src.updated_at
       FROM src
      WHERE r.id = src.room_id
        AND r.matched_at IS NULL
     RETURNING r.id`,
    [matchId],
  )
  return rows[0]?.id ?? null
}

/**
 * Score every available room for a tenant against their preferences,
 * insert suggestions with match_score, and return the top N.
 *
 * Score (0..100):
 *   zone match            30  (CSV in preferences.zone_ids contains room.zone_id)
 *   property_type match   20  (CSV in preferences.property_types contains room.property_type)
 *   bedrooms in [min..max] 20
 *   rent in [min..max]     30
 */
export async function suggestForTenant(tenantId, limit = 10) {
  // 1. Pull tenant preferences (use the most recent row).
  const prefsRes = await query(
    `SELECT zone_ids, property_types, min_bedrooms, max_bedrooms, min_rent, max_rent
       FROM preferences
      WHERE tenant_id = $1 AND role = 'tenant'
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId],
  )
  const pref = prefsRes.rows[0] || {}

  const zoneIds   = (pref.zone_ids || '').split(',').map((s) => s.trim()).filter(Boolean)
  const propTypes = (pref.property_types || '').split(',').map((s) => s.trim()).filter(Boolean)

  // 2. Score all available rooms.
  const ranked = await query(
    `
    WITH scored AS (
      SELECT
        r.id, r.title, r.zone_id, r.property_type, r.bedrooms, r.monthly_rent, r.status,
        z.slug AS zone_slug, z.name_th AS zone_name,
        (
          (CASE WHEN cardinality($1::text[]) = 0 OR z.slug = ANY($1::text[]) THEN 30 ELSE 0 END) +
          (CASE WHEN cardinality($2::text[]) = 0 OR r.property_type = ANY($2::text[]) THEN 20 ELSE 0 END) +
          (CASE
             WHEN $3::int IS NULL THEN 20
             WHEN r.bedrooms BETWEEN $3 AND COALESCE($4, r.bedrooms) THEN 20
             WHEN r.bedrooms BETWEEN $3 - 1 AND $4 THEN 10
             ELSE 0
           END) +
          (CASE
             WHEN $5::int IS NULL THEN 30
             WHEN r.monthly_rent BETWEEN $5 AND COALESCE($6, r.monthly_rent) THEN 30
             WHEN r.monthly_rent BETWEEN $5 AND $6 + 5000 THEN 15
             ELSE 0
           END)
        )::numeric AS match_score
      FROM rooms r
      JOIN zones z ON z.id = r.zone_id
      WHERE r.status = 'available'
    )
    SELECT * FROM scored
    WHERE match_score > 0
    ORDER BY match_score DESC, id ASC
    LIMIT $7
    `,
    [
      zoneIds,
      propTypes,
      pref.min_bedrooms ?? null,
      pref.max_bedrooms ?? null,
      pref.min_rent     ?? null,
      pref.max_rent     ?? null,
      Math.min(limit, 50),
    ],
  )

  // 3. Upsert suggestions, mark previous suggestions for this tenant as
  //    'rejected' if they aren't in the new top N (keeps the queue fresh).
  const topIds = ranked.rows.map((r) => r.id)
  for (const r of ranked.rows) {
    await query(
      `INSERT INTO matches (tenant_id, room_id, status, match_score)
       VALUES ($1, $2, 'suggested', $3)
       ON CONFLICT (tenant_id, room_id) DO UPDATE
         SET match_score = EXCLUDED.match_score,
             updated_at  = NOW()`,
      [tenantId, r.id, r.match_score],
    )
  }
  if (topIds.length) {
    await query(
      `UPDATE matches
          SET status = 'rejected', updated_at = NOW()
        WHERE tenant_id = $1
          AND status = 'suggested'
          AND NOT (room_id = ANY($2::int[]))`,
      [tenantId, topIds],
    )
  }

  return ranked.rows
}

/** Convert a raw snake_case match row to camelCase for the API. */
function rowToMatch(row) {
  return {
    id:          row.id,
    tenantId:    row.tenant_id,
    roomId:      row.room_id,
    status:      row.status,
    matchScore:  row.match_score,
    agentNote:   row.agent_note,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
    tenantName:  row.tenant_name,
    tenantPhone: row.tenant_phone,
    roomTitle:   row.room_title,
    roomRent:    row.room_rent,
    roomBedrooms:row.room_bedrooms,
    roomType:    row.room_type,
    zoneName:    row.zone_name,
    zoneSlug:    row.zone_slug,
  }
}
