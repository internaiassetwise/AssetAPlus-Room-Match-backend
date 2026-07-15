// src/db/repositories/leads.repo.js — Anonymous tenant-lead form (no user FK).
import { query } from '../pool.js'

/**
 * @param {object} input
 * @param {string} [input.zone]
 * @param {number} [input.monthlyBudget]
 * @param {string} [input.propertyType]
 * @param {string} [input.moveIn]
 * @param {string} input.fullName   required
 * @param {string} input.phone      required
 * @param {string} [input.source]
 * @returns {Promise<number>} new lead id
 */
export async function createTenantLead(input) {
  const { rows } = await query(
    `INSERT INTO tenant_leads
       (zone, monthly_budget, property_type, move_in, full_name, phone, source_page)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.zone?.trim() || null,
      Number.isFinite(input.monthlyBudget) ? input.monthlyBudget : null,
      input.propertyType?.trim() || null,
      input.moveIn?.trim() || null,
      input.fullName.trim(),
      input.phone.trim(),
      input.source?.trim() || null,
    ],
  )
  return rows[0].id
}
