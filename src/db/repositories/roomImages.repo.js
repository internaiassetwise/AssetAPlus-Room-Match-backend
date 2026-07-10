// src/db/repositories/roomImages.repo.js — Append-only photo gallery per room.
//
// Rows are insert-only here; reorder/delete lives in the existing room
// admin routes (not implemented for the bot use case yet). The bot uses
// create() + findByRoom() to attach images the landlord sent via Line.

import { query } from '../pool.js'

export async function create(roomId, url, fileName, opts = {}) {
  const { altText = null, sortOrder = null } = opts
  // If sortOrder is null, put new image last.
  let order = sortOrder
  if (order === null) {
    const { rows } = await query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM room_images WHERE room_id = $1',
      [roomId],
    )
    order = rows[0].next
  }
  const { rows } = await query(
    `INSERT INTO room_images (room_id, url, alt_text, sort_order)
     VALUES ($1, $2, $3, $4)
     RETURNING id, room_id, url, alt_text, sort_order, created_at`,
    [roomId, url, altText, order],
  )
  return rowToImage(rows[0])
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