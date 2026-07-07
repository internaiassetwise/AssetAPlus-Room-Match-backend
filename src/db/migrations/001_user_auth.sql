-- ============================================================
-- 001_user_auth.sql — Google OAuth (public users) + Azure SSO (admin).
--
-- Non-destructive: only ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
-- Safe to run on every container start.
-- ============================================================

-- ── tenants: Google identity columns ──
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS google_sub     TEXT UNIQUE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS picture_url    TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS last_login_at  TIMESTAMPTZ;

-- ── tenants: relax NOT NULL on phone ──
-- Google-only users exist as soon as they hit the consent screen, before
-- they ever submit the MatchForm. Their phone is still required at submit
-- time (zod schema enforces it), but the column itself must allow NULL.
ALTER TABLE tenants ALTER COLUMN phone DROP NOT NULL;

-- ── admins: Azure identity columns ──
-- password_hash + username stay — local admin login is still live.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS azure_oid    TEXT UNIQUE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS email        TEXT;
-- last_login_at already exists on admins

-- ── public-user sessions (parallel to admin_sessions) ──
CREATE TABLE IF NOT EXISTS user_sessions (
  token       TEXT PRIMARY KEY,                          -- 64-char hex
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_sessions_expires_idx ON user_sessions(expires_at);