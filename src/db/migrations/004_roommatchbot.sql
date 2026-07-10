-- ============================================================
-- 004_roommatchbot.sql — Tables the Line bot owns.
--
-- The .NET chatbot (asw-roommatchbot-api) writes here when it receives
-- Line webhook events and replies, and when it tracks multi-turn intent
-- conversations. None of these tables are exposed via /api; they're
-- bot-internal.
--
-- Non-destructive: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
-- Safe to run on every container start.
-- ============================================================

-- ── webhook log: every Line event we received ──
CREATE TABLE IF NOT EXISTS ts_LineWebhookLog (
    ID           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "LineUserID" TEXT,
    "ReplyToken" TEXT,
    "EventType"  TEXT         NOT NULL,
    "Event"      TEXT         NOT NULL,
    "CreateDate" TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ts_line_webhook_user ON ts_LineWebhookLog("LineUserID");
CREATE INDEX IF NOT EXISTS idx_ts_line_webhook_date ON ts_LineWebhookLog("CreateDate");

-- ── reply log: every Line reply we sent ──
CREATE TABLE IF NOT EXISTS ts_LineReplyLog (
    ID            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    "LineUserID"  TEXT,
    "ReplyToken"  TEXT,
    "ReplyMessage" TEXT        NOT NULL,
    "CreateDate"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ts_line_reply_user ON ts_LineReplyLog("LineUserID");

-- ── multi-turn conversation state ──
-- One active row per Line user; jsonb blob for collected params.
CREATE TABLE IF NOT EXISTS tm_BotConversation (
    ID               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    "LineUserId"     TEXT        NOT NULL UNIQUE,
    "Intent"         TEXT,
    "CollectedParams" JSONB,
    "UpdatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tm_bot_conversation_updated ON tm_BotConversation("UpdatedAt");