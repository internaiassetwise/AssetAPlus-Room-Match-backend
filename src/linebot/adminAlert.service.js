// src/linebot/adminAlert.service.js — Fan admin alerts out to BOTH the admin
// inbox (admin_queue, the source of truth for replies) AND a Line admin group
// chat (when LINE_ADMIN_GROUP_ID is set) so on-duty admins see new requests
// instantly instead of having to watch the inbox.

import { config } from '../config.js'
import { logger } from '../logger.js'
import { create as createQueue } from '../db/repositories/adminQueue.repo.js'
import * as lineMessaging from './lineMessaging.service.js'

// admin_queue.reason → a short Thai label for the group notification.
const REASON_TAG = {
  'view-a-room': 'นัดชมห้อง',
  'faq-miss': 'คำถามที่บอทตอบไม่ได้',
  'edit-description': 'แก้รายละเอียดห้อง',
  'upload-photos': 'รูปห้อง',
  'create-room-draft': 'ลงประกาศใหม่',
  'system-error': 'ระบบขัดข้อง',
}

/**
 * Create an admin_queue ticket (shows in /admin/inbox) and, when
 * LINE_ADMIN_GROUP_ID is set, push a short heads-up to the admin Line group so
 * someone can react fast. The group push is best-effort — a failure there never
 * blocks the ticket. Returns the created admin_queue row.
 *
 * @param {object} args  { lineUserId, reason, summary, originalPayload }
 */
export async function alertAdmins({ lineUserId, reason, summary, originalPayload }) {
  const row = await createQueue({ lineUserId, reason, summary, originalPayload })

  const groupId = config.LINE_ADMIN_GROUP_ID
  if (groupId && lineMessaging.isConfigured()) {
    const tag = REASON_TAG[reason] || 'แจ้งเตือน'
    const text = `🔔 [${tag}]\n${summary}\n\n— ตอบกลับ/ดำเนินการต่อได้ที่หน้า Admin Inbox`
    lineMessaging.pushMessage(groupId, { type: 'text', text }).catch((err) => {
      logger.error({ err, groupId, reason }, 'admin group push failed')
    })
  }
  return row
}
