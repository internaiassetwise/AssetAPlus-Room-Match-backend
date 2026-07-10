// scripts/reset-admin.mjs — Re-hash the .env ADMIN_PASSWORD into the existing
// admins row so login works after a DB switch (ensureBootstrapAdmin is
// create-only and won't overwrite a pre-existing admin).
//
//   node --env-file=.env scripts/reset-admin.mjs
import bcrypt from 'bcryptjs'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const u = process.env.ADMIN_USERNAME
const p = process.env.ADMIN_PASSWORD

if (!u || !p) {
  console.error('ADMIN_USERNAME/ADMIN_PASSWORD missing from env')
  process.exit(1)
}

const hash = await bcrypt.hash(p, 10)
const r = await pool.query(
  'UPDATE admins SET password_hash = $1, is_active = TRUE WHERE username = $2 RETURNING id, username, is_active',
  [hash, u],
)
const verify = await bcrypt.compare(p, hash) // proves the new hash accepts the .env password
console.log('reset row :', r.rows[0])
console.log('verify ok:', verify, '| username:', u, '| password length:', p.length)
await pool.end()
