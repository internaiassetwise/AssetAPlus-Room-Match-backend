-- Migration 022: a second homepage flag, separate from "ยอดนิยม".
--
-- is_featured drives the "ยอดนิยม" rail on the homepage. The listing form now
-- also offers "ห้องใหม่ล่าสุด", and the two are genuinely different claims —
-- a popular room is not automatically new, and a new one is not yet popular —
-- so they can't share a column.
--
-- Deliberately NOT derived from created_at: "new" here means "we want to
-- promote this", which is an editorial decision. A room re-listed after a
-- tenant moves out is new to the market but old in the table.

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_new_arrival BOOLEAN NOT NULL DEFAULT FALSE;

-- The homepage asks "which rooms carry a flag", never "is this one room
-- flagged", so partial indexes on the true rows are what actually get used.
CREATE INDEX IF NOT EXISTS idx_rooms_new_arrival
  ON rooms (created_at DESC) WHERE is_new_arrival;
