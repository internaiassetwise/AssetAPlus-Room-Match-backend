-- ============================================================
-- 003_landlord_sessions.sql — Landlord-side auth sessions.
--
-- Parallel to user_sessions (tenant side). Same shape + lifecycle:
--   64-char hex token PK, FK to landlords, TTL, expires index.
-- Required so requireLandlord middleware can read a cookie and look
-- up the row — the previous design only supported mock bypass, never
-- real persisted sessions. Persona-based mock login uses these rows
-- just like the real OAuth flow will when it lands.
-- ============================================================

CREATE TABLE IF NOT EXISTS landlord_sessions (
  token        TEXT PRIMARY KEY,                                          -- 64-char hex
  landlord_id  INTEGER NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS landlord_sessions_expires_idx
  ON landlord_sessions(expires_at);
