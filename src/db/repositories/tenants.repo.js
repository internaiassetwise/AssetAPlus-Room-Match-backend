// src/db/repositories/tenants.repo.js — Tenant (renter) CRUD + Google identity upsert.
import { pool } from '../pool.js'

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