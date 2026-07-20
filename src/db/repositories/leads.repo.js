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

/**
 * Fetch every tenant lead (newest first) for the Excel export. Cap is high
 * (5,000) as a safety net — the table is append-only and a typical Room Match
 * deployment sees far fewer rows than that.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=5000]
 * @returns {Promise<Array>} raw rows with snake_case columns
 */
export async function listAll({ limit = 5000 } = {}) {
  const { rows } = await query(
    `SELECT id, zone, monthly_budget, property_type, move_in,
            full_name, phone, source_page, status, created_at
       FROM tenant_leads
       ORDER BY created_at DESC
       LIMIT $1`,
    [Math.min(limit, 5000)],
  )
  return rows
}
