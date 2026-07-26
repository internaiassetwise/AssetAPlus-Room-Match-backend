-- ============================================================
-- 017_viewing_reminders.sql — Track which upcoming-viewing reminders were sent.
--
-- The bot sends a tenant two LINE reminders for a นัดชมห้อง they booked:
--   • 24h reminder — fired when the viewing is between 24h and 2h away
--   • 2h  reminder — fired when the viewing is within the last 2h before it
-- Each column is stamped (atomically, by the scheduler) the moment its reminder
-- is claimed, so a reminder is sent at most once even across restarts / multiple
-- app instances. NULL = not yet sent.
--
-- Non-destructive: ADD COLUMN IF NOT EXISTS. Safe to run on every container start.
-- ============================================================

ALTER TABLE viewings ADD COLUMN IF NOT EXISTS reminder_24h_sent_at TIMESTAMPTZ;
ALTER TABLE viewings ADD COLUMN IF NOT EXISTS reminder_2h_sent_at  TIMESTAMPTZ;

-- Partial index so the scheduler's "upcoming + something still unsent" scan stays
-- cheap as the viewings table grows.
CREATE INDEX IF NOT EXISTS idx_viewings_reminder_due
  ON viewings(scheduled_for)
  WHERE status IN ('requested', 'confirmed')
    AND (reminder_24h_sent_at IS NULL OR reminder_2h_sent_at IS NULL);
