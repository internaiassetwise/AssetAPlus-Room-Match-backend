-- Migration 010: Admin-opened bookable viewing slots per room (Phase 6 booking).
--
-- A landlord/admin opens specific future times for a room; the bot shows them as
-- tappable buttons and a postback books one (→ creates a viewing + marks the slot
-- 'booked'). Replaces free-text time guessing. Idempotent.

CREATE TABLE IF NOT EXISTS viewing_slots (
  id                BIGSERIAL PRIMARY KEY,
  room_id           INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  starts_at         TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','booked','cancelled')),
  booked_viewing_id INTEGER,                       -- the viewings.id once booked
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_viewing_slots_room_open
  ON viewing_slots(room_id, status, starts_at);
