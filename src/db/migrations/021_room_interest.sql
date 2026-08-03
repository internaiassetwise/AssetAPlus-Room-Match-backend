-- Migration 021: which room a customer was looking at when they messaged us.
--
-- A customer taps "สอบถามห้องนี้" on a room page, LINE opens with the question
-- pre-typed, they send it — and on our side it arrived as a bare message with
-- no idea which of the rooms they had been reading. Admin had to ask, and the
-- bot answered generically.
--
-- One row per (person, room, moment). Kept as an append-only trail rather than
-- a single "current room" column: someone comparing three rooms produces three
-- rows, and that sequence is exactly what tells admin what they're weighing up.

CREATE TABLE IF NOT EXISTS room_interest (
  id           BIGSERIAL PRIMARY KEY,
  line_user_id VARCHAR(64) NOT NULL,
  room_id      BIGINT      NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  -- Where the tap came from: 'web-cta' (room page button) today; leaves room
  -- for 'liff' or 'flex-card' without a migration.
  source       TEXT        NOT NULL DEFAULT 'web-cta',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "What was this person just looking at?" — the inbox asks this per user,
-- newest first, on every conversation open.
CREATE INDEX IF NOT EXISTS idx_room_interest_user_recent
  ON room_interest (line_user_id, created_at DESC);

-- "Which rooms are people actually asking about?" — for the admin dashboard.
CREATE INDEX IF NOT EXISTS idx_room_interest_room
  ON room_interest (room_id, created_at DESC);
