-- Migration 020: give every room's gallery a clean 0..n-1 order.
--
-- sort_order was assigned by a SELECT MAX(...) followed by a separate INSERT,
-- so existing rooms start at 0 in some galleries and 1 in others, and rooms
-- that took photos from two sources at once can share a slot. Neither is
-- visible to admin, but both make "first photo = cover" unreliable.
--
-- Renumber in place, keeping the order the gallery already reads in
-- (sort_order, then id) so nothing appears to move.

WITH ranked AS (
  SELECT id,
         (ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY sort_order ASC, id ASC) - 1)::int AS pos
    FROM room_images
)
UPDATE room_images ri
   SET sort_order = ranked.pos
  FROM ranked
 WHERE ri.id = ranked.id
   AND ri.sort_order IS DISTINCT FROM ranked.pos;

-- Deliberately NO unique index on (room_id, sort_order). Reordering a gallery
-- is a permutation, and a plain unique index is enforced row-by-row, so any
-- swap would trip it partway through even though the final state is valid.
-- findByRoom orders by (sort_order, id), which stays deterministic regardless,
-- and create() now picks its slot inside the INSERT, so duplicates aren't
-- being introduced in the first place.
