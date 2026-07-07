// src/server.js — Boot sequence: load env → ping DB → bootstrap admin → listen → trap signals.
import 'dotenv/config'
import { createServer } from 'node:http'
import { config }         from './config.js'
import { logger }         from './logger.js'
import { ping, close as closePool } from './db/pool.js'
import { ensureBootstrapAdmin } from './db/repositories/admins.repo.js'
import { createApp }      from './app.js'

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
  })

  // 4. Graceful shutdown.
  let shuttingDown = false
  const shutdown = (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutting down…')
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