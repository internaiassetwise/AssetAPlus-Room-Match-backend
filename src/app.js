// src/app.js — Express app factory. Pure: no .listen, no process.exit.
import express from 'express'
import helmet  from 'helmet'
import cors    from 'cors'
import compression from 'compression'
import { randomUUID } from 'node:crypto'

import { config } from './config.js'
import { apiRouter } from './routes/index.js'
import { requestLogger } from './middleware/requestLogger.js'
import { notFound }      from './middleware/notFound.js'
import { errorHandler }  from './middleware/error.js'

export function createApp() {
  const app = express()

  // Per-request id (for log correlation; surfaced in error JSON too)
  app.use((req, _res, next) => {
    req.id = req.headers['x-request-id'] || randomUUID()
    next()
  })

  // Security headers — but allow inline styles (Tailwind injection) + cross-origin assets
  app.use(helmet({
    contentSecurityPolicy: false,         // static frontend is separate
    crossOriginEmbedderPolicy: false,
  }))

  // CORS — explicit allow-list in production (so cookies can be sent),
  // reflect any origin in dev. Browsers reject `Access-Control-Allow-Origin: *`
  // combined with `credentials: true`, so production must set CORS_ORIGIN to the
  // frontend URL (or comma-separated list).
  app.use(cors({
    origin: config.CORS_ORIGIN === '*'
      ? true
      : config.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  }))

  app.use(compression())
  app.use(express.json({ limit: '64kb' }))
  app.use(requestLogger())

  // Health is unversioned so uptime monitors can hit it directly
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'room-match-api', ts: Date.now() }))

  // Root — a defensive 200 for platforms (Railway, Render) that probe `/` as a
  // default healthcheck. Also gives curious humans a useful landing response
  // instead of a 404 when they curl the base URL.
  app.get('/', (_req, res) => res.json({ ok: true, service: 'room-match-api', docs: '/api' }))

  // All real endpoints under /api
  app.use('/api', apiRouter)

  app.use('/api', notFound())         // 404 for unknown /api/* routes
  app.use(errorHandler())             // final error → JSON

  return app
}