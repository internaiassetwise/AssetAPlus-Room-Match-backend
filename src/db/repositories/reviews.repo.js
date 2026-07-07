// src/db/repositories/reviews.repo.js — Public featured reviews.
import { query } from '../pool.js'

export async function listFeatured(limit = 12) {
  const { rows } = await query(
    `SELECT reviewer_name AS name,
            reviewer_role AS role,
            avatar_emoji AS avatar,
            rating,
            body AS text
       FROM reviews
      WHERE is_featured = TRUE
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit]
  )
  return rows
}