-- Migration 009: Line chatbot tables.
--
-- Replaces the C# bot's tm_BotConversation (→ chat_sessions),
-- ts_LineWebhookLog / ts_LineReplyLog (→ line_webhook_log / line_reply_log),
-- and bot_inquiries (→ admin_queue, same shape, clearer name).
-- Also extends rooms.status to support a 'pending' state for landlord listings
-- awaiting admin approval, plus audit columns (created_by_line_user_id,
-- approved_at, approved_by).
--
-- Idempotent — safe to run multiple times.

-- ─── chat_sessions (replaces tm_BotConversation) ───────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id              BIGSERIAL PRIMARY KEY,
  line_user_id    VARCHAR(64) NOT NULL UNIQUE,
  history         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  current_intent  VARCHAR(100),
  collected       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_expires ON chat_sessions(expires_at);

CREATE OR REPLACE FUNCTION chat_sessions_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chat_sessions_updated_at ON chat_sessions;
CREATE TRIGGER trg_chat_sessions_updated_at
  BEFORE UPDATE ON chat_sessions
  FOR EACH ROW
  EXECUTE FUNCTION chat_sessions_set_updated_at();

-- ─── admin_queue (replaces bot_inquiries) ──────────────────────────────
-- Same shape as bot_inquiries but the name reflects the new world:
-- everything that lands here is "needs admin attention", not "from the
-- .NET bot". Admin inbox UI now reads this table.
CREATE TABLE IF NOT EXISTS admin_queue (
  id              BIGSERIAL PRIMARY KEY,
  line_user_id    VARCHAR(64) NOT NULL,
  reason          VARCHAR(100) NOT NULL,        -- 'faq-miss' | 'edit-description' |
                                               -- 'upload-photos' | 'view-a-room' |
                                               -- 'create-room-draft' | 'system-error'
  summary         TEXT,
  original_payload JSONB,
  status          VARCHAR(20) NOT NULL DEFAULT 'open',  -- open | replied | resolved
  admin_reply     TEXT,
  replied_at      TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_queue_status_created
  ON admin_queue(status, created_at DESC);

CREATE OR REPLACE FUNCTION admin_queue_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_queue_updated_at ON admin_queue;
CREATE TRIGGER trg_admin_queue_updated_at
  BEFORE UPDATE ON admin_queue
  FOR EACH ROW
  EXECUTE FUNCTION admin_queue_set_updated_at();

-- ─── tenants.line_id becomes the Line identity key ─────────────────────
-- The existing `tenants` table already holds webapp tenants (Google OAuth)
-- and carries `line_id`, `full_name`, `picture_url`, `last_login_at` — we
-- reuse it for Line users too. One user, one row, regardless of whether
-- they came in via webapp OAuth or via Line. A unique partial index on
-- line_id lets us upsert from the webhook handler in O(log n).
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_line_id_unique
  ON tenants(line_id) WHERE line_id IS NOT NULL;

-- ─── rooms.status gains 'pending' and 'removed' ────────────────────────
-- 'pending' = landlord draft waiting for admin approval
-- 'removed' = landlord draft rejected by admin (kept for audit; hidden)
ALTER TABLE rooms
  DROP CONSTRAINT IF EXISTS rooms_status_check;
ALTER TABLE rooms
  ADD CONSTRAINT rooms_status_check
  CHECK (status IN ('pending','available','reserved','matched','inactive','removed'));

-- ─── rooms attribution ─────────────────────────────────────────────────
ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS created_by_line_user_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS approved_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by             VARCHAR(100);

-- ─── audit logs (replaces ts_LineWebhookLog / ts_LineReplyLog) ─────────
CREATE TABLE IF NOT EXISTS line_webhook_log (
  id              BIGSERIAL PRIMARY KEY,
  line_user_id    VARCHAR(64),
  reply_token     VARCHAR(64),
  event_type      VARCHAR(50),
  event           JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_line_webhook_log_user_date
  ON line_webhook_log(line_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS line_reply_log (
  id              BIGSERIAL PRIMARY KEY,
  line_user_id    VARCHAR(64),
  reply_token     VARCHAR(64),
  message         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_line_reply_log_user_date
  ON line_reply_log(line_user_id, created_at DESC);