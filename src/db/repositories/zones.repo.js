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