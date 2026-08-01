// src/server.js — Boot sequence: load env → ping DB → bootstrap admin → listen → trap signals.
import 'dotenv/config'
import { createServer } from 'node:http'
import fs                 from 'node:fs'
import { config, UPLOADS_DIR, PUBLIC_IMAGES_DIR } from './config.js'
import { logger }         from './logger.js'
import { ping, close as closePool } from './db/pool.js'
import { ensureBootstrapAdmin } from './db/repositories/admins.repo.js'
import { createApp }      from './app.js'
import { start as startViewingReminders, stop as stopViewingReminders } from './linebot/viewingReminder.service.js'
import { start as startMaintenance, stop as stopMaintenance } from './services/maintenance.service.js'

async function main() {
  // 1. Verify the DB is reachable BEFORE we accept traffic.
  try {
    const ok = await ping()
    if (!ok) throw new Error('SELECT 1 returned non-truthy')
    logger.info('db ping ok')
  } catch (err) {
    logger.error({ err }, 'db ping failed — set DATABASE_URL to a reachable PostgreSQL')
    process.exit(1)
  }

  // 2. Bootstrap the first admin from env (no-op if already present or unset).
  await ensureBootstrapAdmin({
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
  })

  // 3. Start the HTTP server.
  const app    = createApp()
  const server = createServer(app)
  server.listen(config.PORT, () => {
    logger.info(`🚀 Room Match API on http://localhost:${config.PORT}`)
    logger.info(`   env=${config.NODE_ENV}  cors=${config.CORS_ORIGIN}`)
    // Log where static assets resolve to (and whether they exist). A wrong path
    // here silently 404s every room photo — on the web AND in Line Flex cards —
    // so surfacing it at boot makes that failure obvious instead of mysterious.
    logger.info({
      uploadsDir:   UPLOADS_DIR,
      uploadsExists: fs.existsSync(UPLOADS_DIR),
      imagesDir:    PUBLIC_IMAGES_DIR,
      imagesExists: fs.existsSync(PUBLIC_IMAGES_DIR),
    }, 'static asset dirs')
    // Start the upcoming-viewing LINE reminder scheduler (only in the real
    // server process — never in scripts/tests that just import the repos).
    startViewingReminders()
    // Daily housekeeping: prune expired sessions + old Line traffic logs.
    startMaintenance()
  })

  // 4. Graceful shutdown.
  let shuttingDown = false
  const shutdown = (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutting down…')
    stopViewingReminders()
    stopMaintenance()
    server.close(async () => {
      try { await closePool() } catch (e) { logger.warn({ e }, 'pool end errored') }
      logger.info('bye 👋')
      process.exit(0)
    })
    // hard-exit after 8s if connections won't drain
    setTimeout(() => process.exit(1), 8_000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'unhandledRejection')
    shutdown('unhandledRejection')
  })
}

main().catch((err) => {
  logger.error({ err }, 'fatal boot error')
  process.exit(1)
})