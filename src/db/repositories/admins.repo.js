// src/db/repositories/admins.repo.js — Staff account + session CRUD.
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { pool } from '../pool.js'
import { logger } from '../../logger.js'

/**
 * Ensure a single bootstrap admin exists. Reads ADMIN_USERNAME / ADMIN_PASSWORD
 * from env. Idempotent: skips when an admin row already exists (or env is unset).
 */
export async function ensureBootstrapAdmin({ username, password }) {
  if (!username || !password) {
    logger.warn('ADMIN_USERNAME/ADMIN_PASSWORD not set — admin panel disabled')
    return
  }
  const { rowCount } = await pool.query('SELECT 1 FROM admins LIMIT 1')
  if (rowCount > 0) return
  const hash = await bcrypt.hash(password, 10)
  await pool.query(
    `INSERT INTO admins (username, password_hash) VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [username, hash],
  )
  logger.info({ username }, 'bootstrap admin created/updated')
}

export async function findByUsername(username) {
  const { rows } = await pool.query(
    `SELECT id, username, password_hash, is_active, last_login_at, created_at
       FROM admins WHERE username = $1`,
    [username],
  )
  return rows[0] || null
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash)
}

export async function createSession(adminId, ttlDays = 7) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000)
  await pool.query(
    `INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES ($1, $2, $3)`,
    [token, adminId, expiresAt],
  )
  return { token, expiresAt }
}

/** Returns the admin row (without password_hash) if the token is valid + not expired. */
export async function findSession(token) {
  const { rows } = await pool.query(
    `SELECT a.id, a.username, a.is_active, s.expires_at
       FROM admin_sessions s
       JOIN admins a ON a.id = s.admin_id
      WHERE s.token = $1 AND s.expires_at > NOW() AND a.is_active = TRUE`,
    [token],
  )
  return rows[0] || null
}

export async function destroySession(token) {
  await pool.query('DELETE FROM admin_sessions WHERE token = $1', [token])
}

export async function touchLastLogin(adminId) {
  await pool.query('UPDATE admins SET last_login_at = NOW() WHERE id = $1', [adminId])
}