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

  for (const file of ['schema.sql', 'seed.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8')
    console.log(`⏳  Applying ${file} …`)
    await pool.query(sql)
    console.log(`✅  Applied ${file}`)
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