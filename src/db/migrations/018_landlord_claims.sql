-- ============================================================
-- 018_landlord_claims.sql — One-time links that bind an admin-created landlord
-- to their real LINE identity.
--
-- Admin creates a landlord row (name + phone) with no line_id, generates a claim
-- link, and sends it to the owner. The owner taps it, logs in with LINE once, and
-- /auth/line/callback binds their LINE userId onto that exact landlord row — so
-- the bot and webapp then read the same rows. See docs/LEGACY_LANDLORD_ONBOARDING.md.
--
-- token_hash: we store sha256(raw); the raw token is shown to admin once and never
-- persisted — a claim link may sit in a chat/SMS for weeks, so a DB leak must not
-- yield replayable links.
--
-- Non-destructive: CREATE TABLE / INDEX IF NOT EXISTS. Safe on every start.
-- ============================================================

CREATE TABLE IF NOT EXISTS landlord_claims (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash           TEXT NOT NULL UNIQUE,          -- sha256(raw token), hex
  landlord_id          INTEGER NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  created_by_admin_id  INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  expires_at           TIMESTAMPTZ NOT NULL,
  claimed_at           TIMESTAMPTZ,                   -- NULL until redeemed
  claimed_line_user_id TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_landlord_claims_landlord ON landlord_claims(landlord_id);
