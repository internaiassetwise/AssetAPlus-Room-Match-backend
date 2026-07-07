// src/config.js — Validated environment configuration
// Fail fast at boot if anything is missing or invalid.
import { z } from 'zod'

const schema = z.object({
  NODE_ENV:     z.enum(['development', 'test', 'production']).default('development'),
  PORT:         z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGIN:  z.string().default('*'),
  LOG_LEVEL:    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
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