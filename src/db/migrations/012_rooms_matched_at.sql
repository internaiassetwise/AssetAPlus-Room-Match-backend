-- Migration 012: Denormalise "room has been matched & signed" onto the rooms
-- row so the landing-page stat ('ที่ Match แล้ว') is a cheap COUNT(*) over a
-- single table instead of a join to `matches`. The `matches` table remains the
-- source of truth for match metadata (tenant, score, agent note, lifecycle).
--
-- matched_at = the earliest moment a match for this room reached
-- status='contract_signed'. NULL means the room has never been signed.
--
-- Backfill from any existing contract_signed matches so the count is accurate
-- after the migration runs on a populated DB.
--
-- Idempotent — safe to re-run on container start (init.js reapplies each boot).

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ;

-- Backfill: stamp each room with the earliest contract_signed moment across
-- all of its matches. Wrapped in a CTE so the UPDATE only touches rows that
-- actually need updating; rooms with no contract_signed match stay NULL.
WITH signed AS (
  SELECT room_id, MIN(updated_at) AS first_signed_at
    FROM matches
   WHERE status = 'contract_signed'
   GROUP BY room_id
)
UPDATE rooms r
   SET matched_at = s.first_signed_at
  FROM signed s
 WHERE r.id = s.room_id
   AND r.matched_at IS NULL;

-- Partial index — the stats query filters on `matched_at IS NOT NULL`, so the
-- planner only needs to scan the small subset of rooms that have ever been
-- signed. Much cheaper than a full index on a column that's 99% NULL.
CREATE INDEX IF NOT EXISTS idx_rooms_matched
  ON rooms(matched_at)
  WHERE matched_at IS NOT NULL;
