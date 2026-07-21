// src/db/repositories/adminActions.repo.js — Append-only audit log for admin
// write actions. Insert-only; no update or delete helpers exist by design.
//
// The middleware in middleware/auditAdmin.js calls log() on every mutating
// request that passes requireAdmin. Individual route handlers can also call
// log() directly to attach richer context (entity title, reply excerpt, etc.).

import { pool } from '../pool.js'
import { logger } from '../../logger.js'

/**
 * Insert one audit row. Best-effort — a DB failure here MUST NOT break the
 * request (the admin's action already succeeded), so errors are logged and
 * swallowed.
 *
 * @param {object} e
 * @param {number|null} e.adminId
 * @param {string|null} e.azureOid     Microsoft Entra ID stable user id
 * @param {string}      e.displayName  Snapshot for human-readable logs
 * @param {string}      e.method       POST | PATCH | DELETE
 * @param {string}      e.path
 * @param {string}      [e.action]     Short label (room.approve, faq.update, …)
 * @param {string}      [e.entityType]
 * @param {string}      [e.entityId]
 * @param {number}      [e.statusCode]
 * @param {object}      [e.metadata]   Arbitrary JSON context
 */
export async function log(e) {
  try {
    await pool.query(
      `INSERT INTO admin_action_log
         (admin_id, azure_oid, display_name, method, path, action,
          entity_type, entity_id, status_code, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        e.adminId ?? null,
        e.azureOid ?? null,
        e.displayName ?? null,
        e.method,
        e.path,
        e.action ?? null,
        e.entityType ?? null,
        e.entityId != null ? String(e.entityId) : null,
        e.statusCode ?? null,
        JSON.stringify(e.metadata ?? {}),
      ],
    )
  } catch (err) {
    logger.error({ err, action: e.action, path: e.path }, 'admin action log insert failed')
  }
}
