// src/db/repositories/roomImages.repo.js — Append-only photo gallery per room.
//
// Rows are insert-only here; reorder/delete lives in the existing room
// admin routes (not implemented for the bot use case yet). The bot uses
// create() + findByRoom() to attach images the landlord sent via Line.

import { query } from '../pool.js'

export async function create(roomId, url, fileName, opts = {}) {
  const { altText = null, sortOrder = null } = opts
  // "Next position" is computed INSIDE the insert. It used to be a separate
  // SELECT followed by an INSERT, so two uploads landing on the same room at
  // once — an admin adding photos while the landlord sends more over LINE —
  // could both read the same MAX and take the same slot, leaving an order that
  // depends on row id rather than on what anyone chose.
  const { rows } = await query(
    `INSERT INTO room_images (room_id, url, alt_text, sort_order)
     SELECT $1, $2, $3,
            COALESCE($4::int,
                     (SELECT COALESCE(MAX(sort_order), -1) + 1
                        FROM room_images WHERE room_id = $1))
     RETURNING id, room_id, url, alt_text, sort_order, created_at`,
    [roomId, url, altText, sortOrder],
  )
  return rowToImage(rows[0])
}

/**
 * Stamp a fresh cache-busting token onto a photo's URL.
 *
 * /uploads is served with max-age=7d, so when the watermark job rewrites a file
 * in place the path is unchanged and every browser and LINE client keeps serving
 * the copy it already has — for up to a week. The bytes changed but the name did
 * not, and a cache has no way to know.
 *
 * Bumping ?v= makes it a different URL, so caches miss and refetch immediately.
 * Any existing ?v= is replaced rather than appended, or repeated runs would
 * grow the query string forever.
 *
 * @param {string|number} roomId
 * @param {string} fileName  the stored file name (unique per upload)
 * @param {string|number} token
 */
export async function bumpCacheToken(roomId, fileName, token) {
  if (!roomId || !fileName) return 0
  const { rowCount } = await query(
    `UPDATE room_images
        SET url = split_part(url, '?', 1) || '?v=' || $3
      WHERE room_id = $1
        AND split_part(split_part(url, '?', 1), '/', -1) = $2`,
    [roomId, fileName, String(token)],
  )
  return rowCount
}

/**
 * Rewrite the gallery order for one room.
 *
 * `ids` is the full desired order, first = cover. Ids that don't belong to the
 * room are ignored, and any photo the caller left out keeps its place at the
 * end — so a stale client tab can't silently drop a photo from the gallery.
 * Runs as one statement so a half-applied order is never visible.
 *
 * @returns {Promise<Array>} the room's photos in their new order
 */
export async function reorder(roomId, ids) {
  const clean = (Array.isArray(ids) ? ids : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
  if (!clean.length) return findByRoom(roomId)

  // One statement renumbers the WHOLE gallery: listed photos take the caller's
  // order, anything left out keeps its relative position after them. Doing it
  // in two passes would leave the gallery briefly holding duplicate positions,
  // which is exactly what a concurrent read would pick up.
  await query(
    `WITH desired AS (
       SELECT id, (ordinality - 1)::int AS idx
         FROM unnest($2::bigint[]) WITH ORDINALITY AS t(id, ordinality)
     ), ranked AS (
       SELECT ri.id,
              (ROW_NUMBER() OVER (
                 ORDER BY COALESCE(d.idx, 1000000) ASC, ri.sort_order ASC, ri.id ASC
               ) - 1)::int AS pos
         FROM room_images ri
         LEFT JOIN desired d ON d.id = ri.id
        WHERE ri.room_id = $1
     )
     UPDATE room_images ri
        SET sort_order = ranked.pos
       FROM ranked
      WHERE ri.id = ranked.id
        AND ri.sort_order IS DISTINCT FROM ranked.pos`,
    [roomId, clean],
  )
  return findByRoom(roomId)
}

export async function findByRoom(roomId, { limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT id, room_id, url, alt_text, sort_order, created_at
       FROM room_images
      WHERE room_id = $1
      ORDER BY sort_order ASC, id ASC
      LIMIT $2`,
    [roomId, limit],
  )
  return rows.map(rowToImage)
}

export async function removeByRoom(roomId) {
  await query('DELETE FROM room_images WHERE room_id = $1', [roomId])
}

/**
 * Delete a single image row, scoped to the given room. Returns true if a row
 * was deleted, false if not found (or belongs to a different room).
 */
export async function removeOne(photoId, roomId) {
  const { rowCount } = await query(
    'DELETE FROM room_images WHERE id = $1 AND room_id = $2',
    [photoId, roomId],
  )
  return rowCount > 0
}

function rowToImage(row) {
  return {
    id:        row.id,
    roomId:    row.room_id,
    url:       row.url,
    altText:   row.alt_text,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  }
}