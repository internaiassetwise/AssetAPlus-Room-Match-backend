// src/app.js — Express app factory. Pure: no .listen, no process.exit.
import path from 'node:path'
import express from 'express'
import helmet  from 'helmet'
import cors    from 'cors'
import compression from 'compression'
import { randomUUID } from 'node:crypto'

import { config } from './config.js'
import { apiRouter } from './routes/index.js'
import { logger } from './logger.js'
import { requestLogger } from './middleware/requestLogger.js'
import { notFound }      from './middleware/notFound.js'
import { errorHandler }  from './middleware/error.js'

export function createApp() {
  const app = express()

  // Railway terminates TLS in front of Node, so trust the first proxy hop —
  // otherwise req.protocol is 'http' (stored image URLs come out as http://,
  // which Line Flex rejects, and OIDC callback URLs use the wrong scheme) and
  // req.ip is the proxy address (breaking any future IP-based rate limit).
  app.set('trust proxy', 1)

  // Per-request id (for log correlation; surfaced in error JSON too). Only
  // trust a client-supplied X-Request-Id if it looks like a safe id — otherwise
  // the client could forge/log-spam arbitrary strings into structured logs.
  app.use((req, _res, next) => {
    const sent = req.headers['x-request-id']
    req.id = (typeof sent === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(sent)) ? sent : randomUUID()
    next()
  })

  // Security headers — but allow inline styles (Tailwind injection) + cross-origin assets.
  //
  // Helmet's defaults set CORP/COOP/COEP to `same-origin` to mitigate Spectre-style
  // side-channel attacks. That's correct for an HTML app served from one origin,
  // but it BREAKS cross-origin API responses — the browser drops the response body
  // before JS can read it, and fetch() rejects with "Failed to fetch". Since this
  // API is consumed from a different origin (frontend on `*.up.railway.app`, API on
  // `*.up.railway.app` but a different subdomain), we override CORP/COOP/COEP to
  // permissive values. CORS (configured below) is the real authorization gate.
  app.use(helmet({
    contentSecurityPolicy: false,         // static frontend is separate
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: false,
  }))

  // CORS — explicit allow-list in production (so cookies can be sent),
  // reflect any origin in dev. Browsers reject `Access-Control-Allow-Origin: *`
  // combined with `credentials: true`, so production must set CORS_ORIGIN to the
  // frontend URL (or comma-separated list).
  //
  // Common gotchas this parser defends against:
  //   • Missing protocol   "app.com"               → prepend "https://"
  //   • Trailing slash     "https://app.com/"      → strip trailing "/"
  //   • Surrounding quotes '"https://app.com"'     → strip them
  //   • Trailing comma / whitespace                → trim & filter empties
  const corsOrigins = (() => {
    const raw = (config.CORS_ORIGIN || '').trim()
    if (!raw || raw === '*') return true
    return raw
      .split(',')
      .map((s) => s.trim().replace(/^["']+|["']+$/g, '').replace(/\/+$/, ''))
      .map((s) => /^https?:\/\//i.test(s) ? s : `https://${s}`)
      .filter(Boolean)
  })()
  logger.info({ corsOrigins, raw: config.CORS_ORIGIN }, 'cors config')
  app.use(cors({
    origin: corsOrigins,
    credentials: true,
  }))

  app.use(compression())
  // `verify` captures the raw bytes BEFORE JSON parsing — needed by the Line
  // webhook route to HMAC-verify against the X-Line-Signature header (which
  // is computed over the exact bytes Line sent, not the re-serialised JSON).
  app.use(express.json({
    limit: '64kb',
    verify: (req, _res, buf) => { req.rawBody = buf },
  }))

  // Static /uploads — serves uploaded room photos. The bot (and the
  // /api/my-listings/:id/photos route) write here; the React frontend reads
  // from `${API_BASE}/uploads/...`.
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads'), {
    maxAge: '7d',
    fallthrough: true,
  }))

  // Static /images — demo/seed room photos shipped WITH the backend
  // (public/images/, so they deploy to Railway). room_images.url stores these as
  // relative "/images/<file>" paths; the backend serves them so Line Flex cards
  // can fetch them over the public APP_BASE_URL origin (Line requires absolute
  // https image URLs).
  app.use('/images', express.static(path.join(process.cwd(), 'public', 'images'), {
    maxAge: '7d',
    fallthrough: true,
  }))

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