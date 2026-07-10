// scripts/test-approval.mjs — Phase 5 verification of the approval loop +
// admin_queue inbox at the repo layer (against the configured DATABASE_URL).
//
//   node --env-file=.env scripts/test-approval.mjs
import { createPending, findPending, approve, reject, findAvailable, findById } from '../src/db/repositories/rooms.repo.js'
import { createFromBot } from '../src/db/repositories/landlords.repo.js'
import { findAll } from '../src/db/repositories/zones.repo.js'
import { create as enqueue, list as listQueue, countByStatus } from '../src/db/repositories/adminQueue.repo.js'
import { query, close } from '../src/db/pool.js'

const UID = 'U-phase5-verify'
const log = (...a) => console.log(...a)

// 1. Setup: a stub landlord + a real zone.
const landlord = await createFromBot(UID)
const zone = (await findAll())[0]
log('setup landlord', landlord.id, 'zone', zone.id, zone.name_th)

// 2. Create two pending drafts (as the bot would).
const r1 = await createPending({ landlordId: landlord.id, zoneId: zone.id, title: 'Phase5 อนุมัติ', propertyType: 'condo', bedrooms: 1, bathrooms: 1, monthlyRent: 9000, createdByLineUserId: UID })
const r2 = await createPending({ landlordId: landlord.id, zoneId: zone.id, title: 'Phase5 ปฏิเสธ', propertyType: 'condo', bedrooms: 2, bathrooms: 2, monthlyRent: 12000, createdByLineUserId: UID })
log('created pending', r1.id, r2.id)

// 3. findPending sees them.
const pending = await findPending()
log('findPending count:', pending.length, '| includes r1:', pending.some((r) => r.id === r1.id))

// 4. Approve r1 → available + approvedBy stamped.
const approved = await approve(r1.id, 'admin:verify')
log('approve r1 → status:', approved?.status, '| approvedBy:', approved?.approvedBy, '| createdByLineUserId:', approved?.createdByLineUserId)
const beforeSearch = (await findAvailable({ limit: 200 })).some((r) => r.id === r1.id)
log('r1 visible on webapp search after approve:', beforeSearch)

// 5. Reject r2 → removed, NOT on search.
const rejected = await reject(r2.id)
log('reject r2 → status:', rejected?.status)
const r2onSearch = (await findAvailable({ limit: 200 })).some((r) => r.id === r2.id)
log('r2 visible on webapp search after reject (should be false):', r2onSearch)

// 6. admin_queue inbox: enqueue + list + countByStatus.
const q = await enqueue({ lineUserId: UID, reason: 'edit-description', summary: 'Phase5 inbox test', originalPayload: { roomId: r1.id, description: 'ทดสอบ' } })
const open = await listQueue({ status: 'open' })
const counts = await countByStatus()
log('inbox enqueued', q.id, '| open count:', open.length, '| summary:', counts)

// 7. Approving an already-approved (non-pending) room is a no-op (returns null).
const reApprove = await approve(r1.id, 'admin:verify')
log('re-approve r1 (should be null):', reApprove)

// 8. Cleanup test artifacts.
await query('DELETE FROM rooms WHERE created_by_line_user_id = $1', [UID])
await query('DELETE FROM admin_queue WHERE line_user_id = $1', [UID])
await query('DELETE FROM landlords WHERE line_id = $1', [UID])
log('cleaned up test artifacts for', UID)
await close()
