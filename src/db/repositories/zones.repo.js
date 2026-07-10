// src/db/repositories/zones.repo.js — Active zones with available-room counts.
import { query } from '../pool.js'

export async function listActive() {
  const { rows } = await query(`
    SELECT
      z.slug AS id,
      z.name_th AS name,
      (SELECT COUNT(*) FROM rooms WHERE zone_id = z.id AND status = 'available')::int AS count
    FROM zones z
    WHERE z.is_active = TRUE
    ORDER BY z.sort_order
  `)
  return rows
}

/**
 * All zones (raw rows). Used by the chatbot's searchRooms / createRoomDraft to
 * resolve a free-text location to a numeric zone id. (listActive renames
 * slug→id for the frontend; here we keep the numeric id + both names so the
 * bot can match on Thai name, English name, or slug.)
 */
export async function findAll({ isActive = true } = {}) {
  const { rows } = await query(`
    SELECT id, slug, name_th, name_en, is_active, sort_order
      FROM zones
     WHERE ($1::bool IS NULL OR is_active = $1)
     ORDER BY sort_order, id
  `, [isActive === undefined ? null : isActive])
  return rows
}

/**
 * Resolve a free-text location (Thai name, English name, or slug) to a zone.
 * Exact match is preferred; falls back to a contains match. Returns the zone
 * row { id, slug, name_th, name_en } or null when nothing matches.
 */
export async function findByName(text) {
  const t = String(text ?? '').trim()
  if (!t) return null
  const lower = t.toLowerCase()
  // STRPOS (not ILIKE) for the contains check so user-supplied %/_ aren't read
  // as pattern metacharacters, and NULLS LAST so a NULL name_en can't outrank
  // an exact English-name match (Postgres DESC defaults to NULLS FIRST).
  const { rows } = await query(`
    SELECT id, slug, name_th, name_en
      FROM zones
     WHERE slug = $1
        OR name_th = $1
        OR LOWER(name_en) = $2
        OR STRPOS(LOWER(name_th), $2) > 0
        OR STRPOS(LOWER(COALESCE(name_en, '')), $2) > 0
     ORDER BY (name_th = $1)::int DESC NULLS LAST,
              (LOWER(name_en) = $2)::int DESC NULLS LAST,
              (slug = $1)::int DESC NULLS LAST
     LIMIT 1
  `, [t, lower])
  return rows[0] ?? null
}