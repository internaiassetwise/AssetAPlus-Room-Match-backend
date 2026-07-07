// src/db/repositories/contact.repo.js — Quick contact form messages.
import { query } from '../pool.js'

/**
 * @param {object} input
 * @param {string} input.name      Required
 * @param {string} input.phone     Required
 * @param {string} [input.email]
 * @param {string} [input.message]
 * @param {string} [input.source]
 * @returns {Promise<number>} new message id
 */
export async function create(input) {
  const { rows } = await query(
    `INSERT INTO contact_messages (name, phone, email, message, source_page)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      input.name,
      input.phone,
      input.email || null,
      input.message || null,
      input.source || 'unknown',
    ]
  )
  return rows[0].id
}