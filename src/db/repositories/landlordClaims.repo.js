// src/db/repositories/landlordClaims.repo.js — One-time landlord claim links.
//
// A claim binds an admin-created landlord row to a real LINE identity. We store
// only sha256(raw); the raw token is returned to admin exactly once (at create)
// and travels in the link. Redemption is looked up by hashing the incoming token.

import { createHash, randomBytes } from 'node:crypto'
import { query } from '../pool.js'

const COLS = `id, landlord_id, created_by_admin_id, expires_at, claimed_at,
              claimed_line_user_id, created_at`

function shape(r) {
  if (!r) return null
  return {
    id:                r.id,
    landlordId:        r.landlord_id,
    createdByAdminId:  r.created_by_admin_id,
    expiresAt:         r.expires_at,
    claimedAt:         r.claimed_at,
    claimedLineUserId: r.claimed_line_user_id,
    createdAt:         r.created_at,
  }
}

const hash = (raw) => createHash('sha256').update(String(raw)).digest('hex')

/**
 * Mint a claim for a landlord. Returns { rawToken, claim } — rawToken is shown
 * to admin ONCE (it goes in the link) and is never stored in the clear.
 *
 * @param {number} landlordId
 * @param {number|null} adminId
 * @param {number} ttlDays  link lifetime in days
 */
export async function create(landlordId, adminId = null, ttlDays = 14) {
  const rawToken = randomBytes(32).toString('base64url')
  const { rows } = await query(
    `INSERT INTO landlord_claims (token_hash, landlord_id, created_by_admin_id, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' days')::interval)
     RETURNING ${COLS}`,
    [hash(rawToken), landlordId, adminId, String(ttlDays)],
  )
  return { rawToken, claim: shape(rows[0]) }
}

/** A claim usable right now: not yet redeemed and not expired. Looked up by id. */
export async function findRedeemableById(id) {
  const { rows } = await query(
    `SELECT ${COLS} FROM landlord_claims
      WHERE id = $1 AND claimed_at IS NULL AND expires_at > NOW()`,
    [id],
  )
  return shape(rows[0])
}

/** Same, looked up by the raw token (hashed here). Used at /auth/line/start. */
export async function findRedeemableByToken(rawToken) {
  const { rows } = await query(
    `SELECT ${COLS} FROM landlord_claims
      WHERE token_hash = $1 AND claimed_at IS NULL AND expires_at > NOW()`,
    [hash(rawToken)],
  )
  return shape(rows[0])
}

/** Mark a claim consumed. Idempotent-safe: only stamps a still-unclaimed row. */
export async function markRedeemed(id, lineUserId) {
  const { rows } = await query(
    `UPDATE landlord_claims
        SET claimed_at = NOW(), claimed_line_user_id = $2
      WHERE id = $1 AND claimed_at IS NULL
      RETURNING ${COLS}`,
    [id, lineUserId],
  )
  return shape(rows[0])
}
