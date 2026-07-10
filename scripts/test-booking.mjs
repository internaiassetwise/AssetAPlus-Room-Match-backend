// scripts/test-booking.mjs — Verify the slot booking loop (Phase 6 Feature B):
// open a slot → scheduleViewing offers it as a Flex carousel → postback books it
// → viewing created + slot marked booked → double-book guard holds.
//   node --env-file=.env scripts/test-booking.mjs
import { runOnce } from '../src/linebot/chatAgent.service.js'
import { create as createSlot, findById as findSlot, markBooked } from '../src/db/repositories/viewingSlots.repo.js'
import { handlePostback } from '../src/linebot/lineWebhook.service.js'
import { query, close } from '../src/db/pool.js'

const UID = 'U-phase6-verify'

// 1. Open a bookable slot for room 1, ~2 days out.
const startsAt = new Date(Date.now() + 2 * 864e5).toISOString()
const slot = await createSlot({ roomId: 1, startsAt })
console.log('1. created slot', slot.id, 'status:', slot.status)

// 2. scheduleViewing should offer it as a Flex carousel.
const r = await runOnce(UID, 'อยากนัดชมห้อง 1 ค่ะ')
const p = r.pushes?.[0]
console.log('2. VIEW status:', r.status, '| push0:', p?.type, p?.contents?.type, '| bubbles:', (p?.contents?.contents || []).length)

// 3. Postback books it (exercises the full deterministic path; the Line push to
//    the fake uid fails + is swallowed — the DB writes are what we check).
await handlePostback(UID, `action=book&slotId=${slot.id}`)
const after = await findSlot(slot.id)
console.log('3. slot after book → status:', after?.status, '| bookedViewingId:', after?.bookedViewingId)

// 4. Double-book guard: a second markBooked on the same slot must return null.
const race = await markBooked(slot.id, 999999)
console.log('4. re-book same slot (should be null):', race)

// 5. Confirm the viewing row landed.
const { rows } = await query(
  `SELECT id, room_id, status FROM viewings WHERE tenant_line_user_id=$1 ORDER BY id DESC LIMIT 1`, [UID])
console.log('5. viewing row:', rows[0] || '(none)')

// Cleanup test artifacts.
await query('DELETE FROM viewings WHERE tenant_line_user_id=$1', [UID])
await query('DELETE FROM viewing_slots WHERE id=$1', [slot.id])
await query('DELETE FROM tenants WHERE line_id=$1', [UID])
await query('DELETE FROM chat_sessions WHERE line_user_id=$1', [UID])
console.log('cleaned up')
await close()
