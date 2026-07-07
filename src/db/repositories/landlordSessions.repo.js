// src/db/repositories/landlordSessions.repo.js — Landlord-side session CRUD.
//
// Mirrors userSessions.repo.js — random 64-char hex token, HTTP-only cookie,
// sliding expiry. Landlord cascade-delete cleans up sessions automatically
// when a landlord row is removed.

import crypto from 'node:crypto'
import { pool } from '../pool.js'

export async function createLandlordSession(landlordId, ttlDays = 7) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000)
  await pool.query(
    `INSERT INTO landlord_sessions (token, landlord_id, expires_at) VALUES ($1, $2, $3)`,
    [token, landlordId, expiresAt],
  )
  return { token, expiresAt }
}

/** Returns the joined landlord row if the token is valid + not expired. */
export async function findLandlordSession(token) {
  const { rows } = await pool.query(
    `SELECT l.id AS landlord_id, l.full_name, l.email, l.phone, l.line_id,
            l.company_name, s.expires_at
       FROM landlord_sessions s
       JOIN landlords l ON l.id = s.landlord_id
      WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token],
  )
  return rows[0] || null
}

export async function destroyLandlordSession(token) {
  await pool.query('DELETE FROM landlord_sessions WHERE token = $1', [token])
}
