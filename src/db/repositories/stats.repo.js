// src/db/repositories/stats.repo.js — Aggregate metrics for the landing page.
import { query } from '../pool.js'

export async function getOverview() {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*) FROM rooms WHERE status IN ('available','reserved'))::int AS rooms_total,
      (SELECT COUNT(*) FROM rooms WHERE status = 'available')::int                 AS rooms_available,
      (SELECT COUNT(*) FROM rooms WHERE matched_at IS NOT NULL)::int               AS matches_signed,
      (SELECT ROUND(AVG(rating)::numeric, 1)::float FROM reviews)                   AS avg_rating
  `)
  return rows[0]
}