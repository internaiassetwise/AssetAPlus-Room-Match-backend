// src/db/repositories/userSessions.repo.js — Public-user (tenant) session CRUD.
//
// Mirrors the admin_sessions pattern in admins.repo.js — random 64-char hex
// token, HTTP-only cookie, sliding expiry. Tenant cascade-delete cleans up
// sessions automatically when a tenant row is removed.

import crypto from 'node:crypto'
import { pool } from '../pool.js'

export async function createUserSession(tenantId, ttlDays = 7) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000)
  await pool.query(
    `INSERT INTO user_sessions (token, tenant_id, expires_at) VALUES ($1, $2, $3)`,
    [token, tenantId, expiresAt],
  )
  return { token, expiresAt }
}

/** Returns the joined tenant row if the token is valid + not expired. */
export async function findUserSession(token) {
  const { rows } = await pool.query(
    `SELECT t.id AS tenant_id, t.email, t.full_name, t.picture_url, s.expires_at
       FROM user_sessions s
       JOIN tenants t ON t.id = s.tenant_id
      WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token],
  )
  return rows[0] || null
}

export async function destroyUserSession(token) {
  await pool.query('DELETE FROM user_sessions WHERE token = $1', [token])
}