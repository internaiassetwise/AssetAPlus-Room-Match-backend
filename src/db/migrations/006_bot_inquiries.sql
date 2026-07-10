-- ============================================================
-- 006_bot_inquiries.sql — Bot → admin inquiry inbox.
--
-- When the Line bot can't answer a question on its own (no FAQ match) or
-- receives an intent that requires human action (edit-description, photo
-- upload, viewing request) it POSTs the inquiry here so the admin sees it
-- in /admin/bot-inquiries and can reply. Admin's reply goes back to the
-- tenant via /api/admin/push on the bot.
--
-- status lifecycle:
--   open       — new, admin hasn't touched it
--   replied    — admin replied; the bot already pushed a message to the
--                tenant; user sees the conversation in their inbox
--   resolved   — closed without action (e.g. duplicate, not actionable)
--
-- payload is jsonb so each inquiry type can carry its own shape:
--   ask-about-room  → { text, faqMatched, faqId, confidence }
--   edit-description→ { roomId, description }
--   upload-photos   → { roomId, messageId, url }
--   view-a-room     → { roomId, scheduledAt }
-- ============================================================

CREATE TABLE IF NOT EXISTS bot_inquiries (
  id                  BIGSERIAL PRIMARY KEY,
  line_user_id        TEXT          NOT NULL,
  inquiry_type        TEXT          NOT NULL,             -- ask-about-room | edit-description | upload-photos | view-a-room
  payload             JSONB         NOT NULL DEFAULT '{}'::jsonb,
  status              TEXT          NOT NULL DEFAULT 'open',  -- open | replied | resolved
  admin_reply         TEXT,
  replied_at          TIMESTAMPTZ,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Admin inbox lists newest-first and filters by status constantly.
CREATE INDEX IF NOT EXISTS idx_bot_inquiries_status_date
  ON bot_inquiries(status, created_at DESC);
-- Quick lookup if a tenant sends another question while one is still open.
CREATE INDEX IF NOT EXISTS idx_bot_inquiries_user_open
  ON bot_inquiries(line_user_id) WHERE status = 'open';
-- For "who asked about room #12" debugging.
CREATE INDEX IF NOT EXISTS idx_bot_inquiries_payload_gin
  ON bot_inquiries USING GIN (payload jsonb_path_ops);

-- ── auto-update updated_at ──
CREATE OR REPLACE FUNCTION bot_inquiries_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bot_inquiries_updated_at ON bot_inquiries;
CREATE TRIGGER trg_bot_inquiries_updated_at
  BEFORE UPDATE ON bot_inquiries
  FOR EACH ROW
  EXECUTE FUNCTION bot_inquiries_set_updated_at();