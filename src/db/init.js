// src/db/init.js — Apply schema.sql + seed.sql against DATABASE_URL.
// Usage:  node src/db/init.js [--reset]
//   --reset   drops and recreates the public schema first (destructive!).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'
import { pool, close } from './pool.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESET = process.argv.includes('--reset')

async function run() {
  if (RESET) {
    console.log('🗑   --reset: dropping public schema…')
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
  }

  // Schema is idempotent (CREATE TABLE IF NOT EXISTS) — always safe to re-apply.
  // This is what makes the migration step work on every container start without
  // a migration-tracking table.
  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  console.log('⏳  Applying schema.sql …')
  await pool.query(schemaSql)
  console.log('✅  Applied schema.sql')

  // Seed is NOT fully idempotent — most tables have no natural unique key, so a
  // second run would duplicate rows. Only seed on a fresh DB or when --reset.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM rooms')
  const isEmpty = rows[0].n === 0
  if (RESET || isEmpty) {
    const seedSql = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8')
    console.log('⏳  Applying seed.sql …')
    await pool.query(seedSql)
    console.log('✅  Applied seed.sql')
  } else {
    console.log('⏭   Skipping seed.sql (rooms already populated)')
  }

  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM zones)            AS zones,
      (SELECT COUNT(*) FROM rooms)            AS rooms,
      (SELECT COUNT(*) FROM tenants)          AS tenants,
      (SELECT COUNT(*) FROM reviews)          AS reviews
  `)
  console.log('\n📊 Seed counts:', counts.rows[0])
}

run()
  .then(async () => { await close(); console.log('\n💾  Database ready.'); process.exit(0) })
  .catch(async (err) => {
    console.error('❌  init failed:', err)
    await close()
    process.exit(1)
  })