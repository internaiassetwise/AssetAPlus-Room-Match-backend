// scripts/test-agent.mjs — End-to-end Phase-4 verification of the chat agent.
//
// Runs chatAgent.runOnce() (the function-calling loop) against the LIVE Gemini
// API + the configured database, with a handful of messages that exercise the
// different tool paths. Reads GOOGLE_GEMINI_API_KEY / DATABASE_URL from .env.
// Does NOT push to Line (runOnce is the dry-run core). Writes to chat_sessions
// (and rooms/admin_queue when a tool fires) using a clearly-test lineUserId.
//
//   node scripts/test-agent.mjs
import 'dotenv/config'
import { runOnce } from '../src/linebot/chatAgent.service.js'

const UID = 'U-phase4-verify'

const cases = [
  { label: 'chitchat (expect text, NO tool)', text: 'สวัสดีครับ' },
  { label: 'tenant search (expect searchRooms)', text: 'มีห้องเช่าให้เลือกไหมคะ งบไม่เกินเดือนละ 15000 บาท' },
  { label: 'faq question (expect getFaqAnswer)', text: 'ค่าเช่าต้องจ่ายเมื่อไหร่คะ และต้องวางมัดจำไหม' },
  { label: 'landlord listing (expect createRoomDraft)', text: 'อยากปล่อยห้องคอนโด 2 ห้องนอน 2 ห้องน้ำ ย่านพญาไท ราคา 12000 บาท' },
]

for (const c of cases) {
  console.log('\n========================================')
  console.log(`CASE: ${c.label}`)
  console.log(`USER : ${c.text}`)
  const r = await runOnce(UID, c.text)
  console.log(`STATUS: ${r.status} | pushes: ${r.pushes?.length ?? 0}`)
  console.log(`REPLY : ${r.reply ?? '(none)'}`)
  if (r.pushes?.length) {
    for (const p of r.pushes) console.log(`PUSH  : [${p.type}] ${p.altText ?? ''}`)
  }
}
console.log('\n========================================')
console.log('done. Inspect Railway chat_sessions / rooms / admin_queue for side effects.')
