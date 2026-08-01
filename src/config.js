// src/config.js — Validated environment configuration
// Fail fast at boot if anything is missing or invalid.
import { z } from 'zod'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Absolute path to the server package root (this file lives in <root>/src).
// Deriving paths from the MODULE location instead of process.cwd() keeps static
// assets resolvable no matter which directory the process was started from —
// a cwd mismatch on the host silently 404s every /images and /uploads request.
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const schema = z.object({
  NODE_ENV:           z.enum(['development', 'test', 'production']).default('development'),
  PORT:               z.coerce.number().int().positive().default(4000),
  DATABASE_URL:       z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGIN:        z.string().default('*'),
  LOG_LEVEL:          z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  COOKIE_DOMAIN:      z.string().optional(),   // e.g. ".up.railway.app" in prod for cross-subdomain cookies
  MOCK_AUTH:          z.enum(['true', 'false']).default('false'),  // dev-only mock login flag

  // Line debug routes (/api/line/debug/*) let a caller push arbitrary Line
  // messages / drive the agent as any user. Off by default in EVERY env (so a
  // publicly-reachable staging deploy can't abuse them); set 'true' in local dev.
  ENABLE_LINE_DEBUG:  z.enum(['true', 'false']).default('false'),

  // --- Concurrency / throughput -----------------------------------------
  // Max simultaneous chat turns the bot will process. Different Line users run
  // concurrently up to this cap; the same user is always serialized (one turn at
  // a time, in order) so their chat history can't race. Sized against the DB
  // pool: each turn holds DB connections only during short queries (released
  // during the Gemini await), so 8 leaves headroom for web/admin traffic.
  LINE_BOT_MAX_CONCURRENT: z.coerce.number().int().positive().default(8),

  // Per-LINE-user cap on LLM-backed bot turns. Every text/image message costs a
  // Gemini call, so an unthrottled spammer means an unbounded bill AND starves
  // real users out of the concurrency pool. 20 messages / 5 min is far above
  // normal human pace. Set LINE_BOT_RATE_MAX=0 to disable (not recommended).
  LINE_BOT_RATE_MAX:       z.coerce.number().int().nonnegative().default(20),
  LINE_BOT_RATE_WINDOW_MS: z.coerce.number().int().positive().default(5 * 60_000),

  // How long to keep the diagnostic Line traffic logs (line_webhook_log /
  // line_reply_log) before the daily maintenance sweep prunes them. The durable
  // record of a customer request lives in admin_queue, not here. 0 = keep forever.
  LOG_RETENTION_DAYS:      z.coerce.number().int().nonnegative().default(90),
  // Postgres pool size. Bumped from 10 to give headroom when the bot is busy.
  DB_POOL_MAX:             z.coerce.number().int().positive().default(20),

  // --- Gemini API (FAQ embeddings + rephrasing) -------------------------
  // Optional. If absent, /api/faqs and /api/faqs/search return 503 instead
  // of crashing. Admins can still manage FAQs but embedding generation
  // must wait until the key is set.
  GOOGLE_GEMINI_API_KEY:  z.string().optional(),
  // The embedding model. text-embedding-004 returns 768-dim vectors at
  // outputDimensionality=768. We hardcode 768 in the FAQ embedding column.
  GOOGLE_GEMINI_EMBED_MODEL: z.string().default('text-embedding-004'),
  // The LLM for rephrasing the FAQ answer in friendly Thai tone.
  GOOGLE_GEMINI_REPHRASE_MODEL: z.string().default('gemini-2.5-flash'),

  // --- Line chatbot (now lives in this Express process) -----------------
  // The Line Messaging API credentials. Required for outbound push and for
  // verifying inbound webhooks (HMAC-SHA256 of raw body using the channel
  // secret as the key, compared to the X-Line-Signature header).
  // Optional at boot — if absent, /api/line/webhook returns 503 and the
  // rest of the app continues to work.
  LINE_CHANNEL_ACCESS_TOKEN: z.string().optional(),
  LINE_CHANNEL_SECRET:       z.string().optional(),
  // The Line user id of the admin (for owner-facing notifications:
  // forwarded escalations, system errors, "your listing was approved"
  // pings). Optional.
  LINE_ADMIN_USER_ID:        z.string().optional(),
  // Line group chat that holds the on-duty admins. When set, admin alerts fan
  // out to this group too (in addition to /admin/inbox) for faster reaction.
  // The bot is passive in the group — it only pushes alerts, never replies to
  // chatter. Get the id by adding the bot to the group (it posts the id on join)
  // or from the webhook log's source.groupId.
  LINE_ADMIN_GROUP_ID:        z.string().optional(),
  // Base URLs for the Line APIs. Default to the public Line endpoints;
  // override only when running against a sandbox.
  LINE_API_BASE_URL:  z.string().url().default('https://api.line.me/v2/bot'),
  LINE_DATA_BASE_URL: z.string().url().default('https://api-data.line.me/v2/bot'),
  // LIFF app id for the listing form (Feature C); the bot links to it when set.
  // When configured, createRoomDraft pushes a fillable Flex card instead of
  // extracting fields from chat — the landlord completes the form in Line and
  // it submits straight to /api/liff/listing/submit.
  LIFF_LISTING_ID:    z.string().optional(),

  // LINE Login (web OAuth) for tenants + landlords. Shares the same LINE Login
  // channel as the LIFF listing form. When set, /auth/line/start logs a user in
  // with their Line account and links them to tenants/landlords by line_id.
  LINE_LOGIN_CHANNEL_ID:     z.string().optional(),
  LINE_LOGIN_CHANNEL_SECRET: z.string().optional(),
  LINE_LOGIN_REDIRECT_URI:   z.string().url().optional(),

  // HMAC key for self-contained OAuth state tokens (see auth/stateToken.js).
  // Optional — stateToken falls back to LINE_LOGIN_CHANNEL_SECRET. Set a
  // dedicated value if you want state signing decoupled from the Line secret.
  OAUTH_STATE_SECRET:        z.string().optional(),

  // Public base URL of THIS backend, used to build absolute URLs for room photos
  // the bot saves (room_images.url). Defaults to localhost:<PORT> for dev; set
  // APP_BASE_URL in prod to the reachable origin (e.g. https://room-match.up.railway.app).
  APP_BASE_URL: z.string().url().optional(),

  // Public origin of the WEB APP (the React tenant site). Used to build links to
  // room pages from the Line chatbot — the ดูรายละเอียด button on a room card
  // opens `${WEB_BASE_URL}/rooms/:id`. Falls back to APP_BASE_URL when the site
  // is served from the same origin as the backend. Set it to the deployed site
  // URL (e.g. https://room-match-web.up.railway.app) so a phone tap opens a real
  // page; if neither is set the button falls back to an in-chat message.
  WEB_BASE_URL: z.string().url().optional(),

  // Directory where uploaded room photos are written + served from (/uploads).
  // Railway's container filesystem is EPHEMERAL — it's wiped on every redeploy,
  // so uploads vanish and their URLs 404. Attach a Railway Volume and point this
  // at its mount path (e.g. /app/uploads or /data) so photos persist. Defaults to
  // <cwd>/uploads for local dev.
  UPLOADS_DIR: z.string().optional(),
}).refine(
  // Production must never ship with a wildcard CORS origin. `*` + `credentials:
  // true` + SameSite=None cookies lets any site make credentialed requests as
  // the victim (full account takeover). Fail fast at boot instead of running
  // wide-open. Set CORS_ORIGIN to the frontend origin in prod.
  (d) => !(d.NODE_ENV === 'production' && d.CORS_ORIGIN === '*'),
  { message: 'CORS_ORIGIN must be set to a specific origin in production (not "*")', path: ['CORS_ORIGIN'] },
)

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('❌  Invalid environment configuration:')
  for (const issue of parsed.error.issues) {
    console.error(`   • ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

export const config = parsed.data

// Resolved uploads directory (absolute). Point UPLOADS_DIR at a persistent
// Railway Volume mount in prod; falls back to <serverRoot>/uploads (NOT cwd —
// see SERVER_ROOT above) for local dev.
export const UPLOADS_DIR = config.UPLOADS_DIR || path.join(SERVER_ROOT, 'uploads')

// Seeded/demo room photos shipped with the backend (git-tracked public/images).
export const PUBLIC_IMAGES_DIR = path.join(SERVER_ROOT, 'public', 'images')

// Derived helpers
export const isProd = config.NODE_ENV === 'production'
export const isDev  = config.NODE_ENV === 'development'