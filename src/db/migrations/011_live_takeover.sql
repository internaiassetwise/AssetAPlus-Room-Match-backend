-- Migration 011: Live admin takeover of a Line conversation.
--
-- When a user needs a human (the bot escalates, or an admin manually grabs the
-- chat), the bot is MUTED for that line_user and every message routes to the
-- admin inbox instead of Gemini — until the admin hands control back.
--
-- chat_sessions gains a per-user `handler` flag + the live ticket it's linked to.
-- admin_queue gains a running `thread` JSONB so a live ticket holds the whole
-- back-and-forth (user + admin turns), not just a single one-shot reply.
--
-- Idempotent — safe to run multiple times (auto-applied at container start).

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS handler          TEXT NOT NULL DEFAULT 'ai'
    CHECK (handler IN ('ai','human')),
  ADD COLUMN IF NOT EXISTS active_ticket_id BIGINT,
  ADD COLUMN IF NOT EXISTS taken_over_by    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS taken_over_at    TIMESTAMPTZ;

ALTER TABLE admin_queue
  ADD COLUMN IF NOT EXISTS thread JSONB NOT NULL DEFAULT '[]'::jsonb;
