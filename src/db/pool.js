// src/db/pool.js — Singleton pg.Pool + small query/transaction helpers.
import pg from 'pg'
import { config } from '../config.js'
import { logger } from '../logger.js'

const { Pool } = pg

// SSL is required by Supabase / Render Postgres. Local Docker Postgres runs
// plain TCP, so we auto-detect: enable SSL only when the host isn't local.
const isLocal = /localhost|127\.0\.0\.1|::1/.test(new URL(config.DATABASE_URL).hostname)

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
})

pool.on('error', (err) => {
  logger.error({ err }, 'unexpected pg pool error')
})

/** Run a parameterized query and return rows. */
export async function query(text, params = []) {
  return pool.query(text, params)
}

/** Borrow a client from the pool and run `fn(client)` inside a transaction. */
export async function withTransaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* ignore */ }
    throw err
  } finally {
    client.release()
  }
}

/** Ping the database (used by /api/health). */
export async function ping() {
  const { rows } = await pool.query('SELECT 1 AS ok')
  return rows[0]?.ok === 1
}

/** Close the pool. Used during graceful shutdown. */
export async function close() {
  await pool.end()
}