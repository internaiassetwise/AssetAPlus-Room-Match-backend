// src/db/repositories/tenants.repo.js — Tenant (renter) CRUD + Google identity upsert.
import { pool } from '../pool.js'

/**
 * List all tenants for the admin matching panel. Newest first.
 * Returns id, name, phone, email, line_id, source — enough context for an
 * admin to identify and match a tenant to a room.
 */
export async function findAll({ limit = 500 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, full_name, phone, email, line_id, source, created_at
       FROM tenants
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.min(limit, 1000)],
  )
  return rows
}

/** Look up a tenant by their stable Google 'sub' id. Returns null if absent. */
export async function findByGoogleSub(sub) {
  const { rows } = await pool.query(
    'SELECT * FROM tenants WHERE google_sub = $1',
    [sub],
  )
  return rows[0] || null
}

/**
 * Insert-or-update a tenant keyed by google_sub. Returns the row.
 *
 * On update: refreshes email/picture/last_login_at, but only fills `full_name`
 * when it was previously NULL — once the user has edited their name, we
 * respect that edit and don't overwrite it from Google on every login.
 */
export async function upsertFromGoogle({ sub, email, emailVerified, name, picture }) {
  const { rows } = await pool.query(
    `INSERT INTO tenants
       (google_sub, email, email_verified, full_name, picture_url, last_login_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (google_sub) DO UPDATE
       SET email          = EXCLUDED.email,
           email_verified = EXCLUDED.email_verified,
           full_name      = COALESCE(tenants.full_name, EXCLUDED.full_name),
           picture_url    = EXCLUDED.picture_url,
           last_login_at  = NOW(),
           updated_at     = NOW()
     RETURNING *`,
    [sub, email, !!emailVerified, name || null, picture || null],
  )
  return rows[0]
}

/**
 * Update the mutable profile fields that the MatchForm lets the user edit.
 * Each field is optional — we only overwrite what's passed in.
 */
export async function updateTenantProfile(tenantId, {
  phone, occupation, monthlyIncome, moveInDate, hasPets, smoker, fullName, email,
}) {
  await pool.query(
    `UPDATE tenants
        SET phone          = COALESCE($2, phone),
            full_name      = COALESCE($3, full_name),
            email          = COALESCE($4, email),
            occupation     = COALESCE($5, occupation),
            monthly_income = COALESCE($6, monthly_income),
            move_in_date   = COALESCE($7, move_in_date),
            has_pets       = COALESCE($8, has_pets),
            smoker         = COALESCE($9, smoker),
            updated_at     = NOW()
      WHERE id = $1`,
    [
      tenantId,
      phone ?? null,
      fullName ?? null,
      email ?? null,
      occupation ?? null,
      monthlyIncome ?? null,
      moveInDate ?? null,
      hasPets ?? null,
      smoker ?? null,
    ],
  )
}

/**
 * Look up a tenant by their Line userId. Returns null if absent.
 * Used by the .NET chat bot when a tenant books a viewing through chat.
 */
export async function findByLineId(lineUserId) {
  if (!lineUserId) return null
  const { rows } = await pool.query(
    'SELECT * FROM tenants WHERE line_id = $1',
    [lineUserId],
  )
  return rows[0] || null
}

/**
 * Create a stub tenant row from a Line userId. The bot can book viewings /
 * receive inquiries before the tenant has filled in name + phone. Admin
 * (or the tenant via the web app later) fills in the real values later.
 *
 * full_name is NOT NULL in the schema; we use a placeholder derived from
 * the lineUserId until the tenant completes their profile.
 */
export async function createFromBot(lineUserId) {
  const stubName = `Line user ${lineUserId.slice(0, 8)}`
  const { rows } = await pool.query(
    `INSERT INTO tenants (full_name, line_id, source)
     VALUES ($1, $2, 'line-bot')
     RETURNING *`,
    [stubName, lineUserId],
  )
  return rows[0]
}

/**
 * Capture the Line display name + profile picture on webapp login.
 *
 * The bot stubs a tenant as "Line user <id>" because full_name is NOT NULL; on
 * first webapp login we promote that placeholder to the real Line displayName.
 * We deliberately do NOT overwrite a name that was ever set to something else
 * (an admin capture or a MatchForm edit) — the name is user-owned, Line only
 * fills the blank. picture_url refreshes on every login (cheap, always current).
 */
export async function refreshFromLine(tenantId, { displayName, pictureUrl } = {}) {
  const name = displayName && String(displayName).trim() ? String(displayName).trim() : null
  await pool.query(
    `UPDATE tenants
        SET full_name   = CASE WHEN full_name LIKE 'Line user %' AND $2::text IS NOT NULL
                               THEN $2::text ELSE full_name END,
            picture_url = COALESCE($3, picture_url),
            updated_at  = NOW()
      WHERE id = $1`,
    [tenantId, name, pictureUrl || null],
  )
}