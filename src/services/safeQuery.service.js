// src/services/safeQuery.service.js — Parameterised read-only SQL behind a
// hard-coded whitelist. Used by the FAQ block renderer for Count / Stat /
// Single / List blocks.
//
// Safety boundary (load-bearing rule):
//   - Table and column names come ONLY from ALLOWED_TABLES below.
//   - conditions[].value is sent as a $N parameter — never interpolated.
//   - op / aggregate.fn / orderBy.dir are matched against sets of literal
//     strings.
//   - limit is hard-capped at HARD_LIMIT.
//
// The rest of the app's pool.query() calls stay unchanged — we borrow a
// dedicated client and run SET LOCAL statement_timeout inside an implicit
// transaction to keep the rest of the app's behaviour identical.

import { pool } from '../db/pool.js'
import { AppError } from '../middleware/AppError.js'

const ALLOWED_TABLES = {
  rooms: {
    columns: ['id', 'title', 'monthly_rent', 'bedrooms', 'bathrooms',
              'size_sqm', 'status', 'zone_id', 'landlord_id',
              'is_featured', 'available_from', 'created_at'],
    numericCols: ['monthly_rent', 'bedrooms', 'bathrooms', 'size_sqm'],
    orderable: ['id', 'monthly_rent', 'bedrooms', 'size_sqm', 'created_at'],
  },
  viewings: {
    columns: ['id', 'room_id', 'tenant_id', 'scheduled_for', 'status',
              'requested_at', 'created_at'],
    numericCols: ['room_id', 'tenant_id'],
    orderable: ['scheduled_for', 'requested_at', 'created_at'],
  },
  tenants: {
    columns: ['id', 'full_name', 'phone', 'email', 'monthly_income',
              'move_in_date', 'is_active', 'created_at'],
    numericCols: ['monthly_income'],
    orderable: ['id', 'created_at'],
  },
}

const ALLOWED_OPS = new Set(['=', '!=', '<', '<=', '>', '>=', 'IN',
                             'IS NULL', 'IS NOT NULL'])
const ALLOWED_AGGS = new Set(['COUNT', 'AVG', 'MIN', 'MAX'])
const HARD_LIMIT = 5

/**
 * @typedef {Object} Condition
 * @property {string} col     — column name; must be in table's column list.
 * @property {string} op      — one of '=' | '!=' | '<' | '<=' | '>' | '>='
 *                              | 'IN' | 'IS NULL' | 'IS NOT NULL'.
 *                              'IN' requires value to be an array.
 *                              'IS NULL' / 'IS NOT NULL' ignore value.
 * @property {string|number|string[]|number[]} [value]
 */

/**
 * @typedef {Object} QuerySpec
 * @property {keyof ALLOWED_TABLES} table
 * @property {string[]}            [columns]   for SELECT; default ['*']
 * @property {{fn: 'COUNT'|'AVG'|'MIN'|'MAX', col: string}} [aggregate]
 * @property {Condition[]}          conditions  AND'd together
 * @property {{column: string, dir: 'ASC'|'DESC'}} [orderBy]
 * @property {number} [limit]    hard-capped at HARD_LIMIT
 */

/**
 * Run a read-only SELECT against an allow-listed table.
 * Returns array of objects: one row for aggregate/single, N rows for list.
 *
 * @param {QuerySpec} spec
 * @returns {Promise<object[]>}
 */
export async function runSafe(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new AppError(400, 'SAFE_QUERY_INVALID', 'runSafe: missing spec')
  }

  const tableDef = ALLOWED_TABLES[spec.table]
  if (!tableDef) {
    throw new AppError(400, 'SAFE_QUERY_TABLE',
      `runSafe: table "${spec.table}" is not allowed`)
  }

  // ---- SELECT clause -----------------------------------------------------
  let selectClause
  if (spec.aggregate) {
    const { fn, col } = spec.aggregate
    if (!ALLOWED_AGGS.has(fn)) {
      throw new AppError(400, 'SAFE_QUERY_AGG',
        `runSafe: aggregate fn "${fn}" is not allowed`)
    }
    if (fn !== 'COUNT' && !tableDef.columns.includes(col)) {
      throw new AppError(400, 'SAFE_QUERY_COL',
        `runSafe: column "${col}" is not in ${spec.table}`)
    }
    selectClause = fn === 'COUNT'
      ? `COUNT(*) AS value`
      : `${fn}("${col}") AS value`
  } else {
    const req = Array.isArray(spec.columns) && spec.columns.length
      ? spec.columns
      : ['*']
    if (!(req.length === 1 && req[0] === '*')) {
      for (const c of req) {
        if (!tableDef.columns.includes(c)) {
          throw new AppError(400, 'SAFE_QUERY_COL',
            `runSafe: column "${c}" is not in ${spec.table}`)
        }
      }
      selectClause = req.map((c) => `"${c}"`).join(', ')
    } else {
      selectClause = '*'
    }
  }

  // ---- WHERE clause (always parameterised) -------------------------------
  const where = []
  const params = []
  const conditions = Array.isArray(spec.conditions) ? spec.conditions : []
  for (const c of conditions) {
    if (!c || typeof c !== 'object') {
      throw new AppError(400, 'SAFE_QUERY_COND', 'runSafe: bad condition')
    }
    if (!ALLOWED_OPS.has(c.op)) {
      throw new AppError(400, 'SAFE_QUERY_OP',
        `runSafe: op "${c.op}" is not allowed`)
    }
    if (!tableDef.columns.includes(c.col)) {
      throw new AppError(400, 'SAFE_QUERY_COL',
        `runSafe: column "${c.col}" is not in ${spec.table}`)
    }
    if (c.op === 'IS NULL' || c.op === 'IS NOT NULL') {
      where.push(`"${c.col}" ${c.op}`)
      continue
    }
    if (c.op === 'IN') {
      if (!Array.isArray(c.value) || c.value.length === 0) {
        throw new AppError(400, 'SAFE_QUERY_VALUE',
          'runSafe: IN requires a non-empty array value')
      }
      const placeholders = []
      for (const v of c.value) {
        params.push(v)
        placeholders.push(`$${params.length}`)
      }
      where.push(`"${c.col}" IN (${placeholders.join(', ')})`)
      continue
    }
    params.push(c.value)
    where.push(`"${c.col}" ${c.op} $${params.length}`)
  }

  // ---- ORDER BY ----------------------------------------------------------
  let orderBy = ''
  if (spec.orderBy && !spec.aggregate) {
    const { column: col, dir } = spec.orderBy
    if (!tableDef.orderable.includes(col)) {
      throw new AppError(400, 'SAFE_QUERY_ORDER',
        `runSafe: column "${col}" is not orderable in ${spec.table}`)
    }
    if (dir !== 'ASC' && dir !== 'DESC') {
      throw new AppError(400, 'SAFE_QUERY_ORDER_DIR',
        'runSafe: orderBy.dir must be ASC or DESC')
    }
    orderBy = `ORDER BY "${col}" ${dir}`
  }

  // ---- LIMIT -------------------------------------------------------------
  const limitClause = spec.aggregate
    ? ''
    : `LIMIT ${Math.min(Math.max(parseInt(spec.limit, 10) || HARD_LIMIT, 1), HARD_LIMIT)}`

  const sql = `SELECT ${selectClause} FROM "${spec.table}"${
    where.length ? ` WHERE ${where.join(' AND ')}` : ''
  } ${orderBy} ${limitClause}`.replace(/\s+/g, ' ').trim()

  // Per-query statement timeout (2s). Borrowed client, implicit transaction.
  // The rest of the app keeps using the shared pool unchanged.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout = '2s'")
    const r = await client.query(sql, params)
    await client.query('COMMIT')
    return r.rows
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* ignore */ }
    if (err && err.code === '57014') {
      throw new AppError(504, 'SAFE_QUERY_TIMEOUT',
        'runSafe: query exceeded 2s timeout')
    }
    throw err
  } finally {
    client.release()
  }
}