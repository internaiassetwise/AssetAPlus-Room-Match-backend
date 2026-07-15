-- Migration 013: Backfill room_images for every room that has none.
--
-- Why: rooms.repo.js's SELECT_ROOM pulls the primary image via a subquery
--   (SELECT url FROM room_images WHERE room_id = r.id ORDER BY sort_order LIMIT 1)
-- so rooms without any room_images row come back with image_url = NULL, and the
-- frontend's RoomCard then has to fall back to a hashed mock-image. The fallback
-- works for a few files but is fragile (lazy-load, stale bundles, etc.). One
-- row per room means the DB is self-sufficient: the API always returns a real
-- photo, and the listings grid never has to depend on frontend bundle contents.
--
-- Default choice is /images/room-modern.jpg because it exists in the
-- client/public/images directory shipped with the frontend, and is also served
-- by the backend at /images/room-modern.jpg, so either origin can render it.
--
-- Idempotent — the NOT EXISTS guard means re-running on a populated DB is a
-- no-op (rooms that already have a room_images row are skipped). The PK
-- alone prevents duplicate room_images.id inserts, so no ON CONFLICT clause
-- is needed (there's no UNIQUE on (room_id, url) — same room with different
-- image URLs is allowed; we just want at least one row per room).

INSERT INTO room_images (room_id, url, alt_text, sort_order)
SELECT r.id, '/images/room-modern.jpg', r.title, 1
  FROM rooms r
 WHERE NOT EXISTS (
   SELECT 1 FROM room_images ri WHERE ri.room_id = r.id
 );
