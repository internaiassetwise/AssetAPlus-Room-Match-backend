// src/config.js — Validated environment configuration
// Fail fast at boot if anything is missing or invalid.
import { z } from 'zod'

const schema = z.object({
  NODE_ENV:           z.enum(['development', 'test', 'production']).default('development'),
  PORT:               z.coerce.number().int().positive().default(4000),
  DATABASE_URL:       z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGIN:        z.string().default('*'),
  LOG_LEVEL:          z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  COOKIE_DOMAIN:      z.string().optional(),   // e.g. ".up.railway.app" in prod for cross-subdomain cookies
  MOCK_AUTH:          z.enum(['true', 'false']).default('false'),  // dev-only mock login flag

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
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('❌  Invalid environment configuration:')
  for (const issue of parsed.error.issues) {
    console.error(`   • ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

export const config = parsed.data

// Derived helpers
export const isProd = config.NODE_ENV === 'production'
export const isDev  = config.NODE_ENV === 'development'