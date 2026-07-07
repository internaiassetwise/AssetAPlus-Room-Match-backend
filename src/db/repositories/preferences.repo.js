// src/db/repositories/preferences.repo.js — "ฝากห้อง" form submission.
//
// Creates a landlord row + a preference row in one transaction so we never end
// up with an orphaned preference.
import { withTransaction } from '../pool.js'

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
 * Tenant-side preference. Inserts a tenant row + a preferences row in one
 * transaction (so we never end up with an orphaned preference).
 *
 * @returns {Promise<number>} new tenant id
 */
export async function createTenantPreference(input) {
  return withTransaction(async (client) => {
    const { rows: tenantRows } = await client.query(
      `INSERT INTO tenants
         (full_name, phone, email, occupation, monthly_income, move_in_date,
          has_pets, smoker)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.name,
        input.phone,
        input.email || null,
        input.occupation || null,
        input.monthlyIncome ? Number(input.monthlyIncome) : null,
        input.moveInDate || null,
        Boolean(input.hasPets),
        Boolean(input.smoker),
      ],
    )
    const tenant_id = tenantRows[0].id

    await client.query(
      `INSERT INTO preferences
         (tenant_id, role, zone_ids, property_types,
          min_bedrooms, max_bedrooms, min_rent, max_rent, note)
       VALUES ($1, 'tenant', $2, $3, $4, $5, $6, $7, $8)`,
      [
        tenant_id,
        input.zone ? String(input.zone) : null,
        input.propertyType ? String(input.propertyType) : null,
        input.minBedrooms != null && input.minBedrooms !== '' ? Number(input.minBedrooms) : null,
        input.maxBedrooms != null && input.maxBedrooms !== '' ? Number(input.maxBedrooms) : null,
        input.minRent     != null && input.minRent     !== '' ? Number(input.minRent)     : null,
        input.maxRent     != null && input.maxRent     !== '' ? Number(input.maxRent)     : null,
        input.note || null,
      ],
    )
    return tenant_id
  })
}