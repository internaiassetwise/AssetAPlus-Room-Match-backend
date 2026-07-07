// src/db/repositories/preferences.repo.js — "ฝากห้อง / หาห้อง" form submission.
//
// Landlord flow stays anonymous (a landlord row + a preference row in one tx).
// Tenant flow splits: profile fields go to tenants.repo.updateTenantProfile,
// the preferences row is inserted here. Tenant identity already exists —
// Google sign-in created the row before MatchForm was even submitted.
import { withTransaction } from '../pool.js'
import * as tenants from './tenants.repo.js'

/**
 * @param {object} input
 * @param {string} input.name      Required
 * @param {string} input.phone     Required
 * @param {string} [input.email]
 * @param {string} [input.zone]
 * @param {string} [input.propertyType]
 * @param {number} [input.bedrooms]
 * @param {string} [input.note]
 * @returns {Promise<number>} new landlord_id (also preference row's landlord_id)
 */
export async function createLandlordPreference(input) {
  return withTransaction(async (client) => {
    const { rows: landlordRows } = await client.query(
      `INSERT INTO landlords (full_name, phone, email)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [input.name, input.phone, input.email || null]
    )
    const landlord_id = landlordRows[0].id

    await client.query(
      `INSERT INTO preferences
         (landlord_id, role, zone_ids, property_types, min_bedrooms, max_bedrooms,
          min_rent, max_rent, min_size_sqm, note)
       VALUES ($1, 'landlord', $2, $3, $4, NULL, NULL, NULL, NULL, $5)`,
      [
        landlord_id,
        input.zone ? String(input.zone) : null,
        input.propertyType ? String(input.propertyType) : null,
        input.bedrooms ? Number(input.bedrooms) : null,
        input.note || null,
      ]
    )
    return landlord_id
  })
}

/**
 * Insert just the `preferences` row for a tenant who already exists
 * (created earlier via Google OAuth). Profile fields (phone, occupation,
 * etc.) live on the tenants table and are updated by tenants.repo.
 *
 * Wrapped in a tx so a failed INSERT doesn't leave a half-written preference.
 *
 * @returns {Promise<number>} new preference id
 */
export async function createPreferenceForTenant(tenantId, input) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO preferences
         (tenant_id, role, zone_ids, property_types,
          min_bedrooms, max_bedrooms, min_rent, max_rent, note)
       VALUES ($1, 'tenant', $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        tenantId,
        input.zone ? String(input.zone) : null,
        input.propertyType ? String(input.propertyType) : null,
        input.minBedrooms != null && input.minBedrooms !== '' ? Number(input.minBedrooms) : null,
        input.maxBedrooms != null && input.maxBedrooms !== '' ? Number(input.maxBedrooms) : null,
        input.minRent     != null && input.minRent     !== '' ? Number(input.minRent)     : null,
        input.maxRent     != null && input.maxRent     !== '' ? Number(input.maxRent)     : null,
        input.note || null,
      ],
    )
    return rows[0].id
  })
}

/** Re-export so callers can update profile fields through one repo surface. */
export { updateTenantProfile } from './tenants.repo.js'