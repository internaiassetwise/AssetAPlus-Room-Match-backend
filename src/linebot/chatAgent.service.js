// src/linebot/chatAgent.service.js — The brain of the Line chatbot (Phase 4).
//
// handle(lineUserId, text):
//   1. append the user message to chat_sessions.history
//   2. run the Gemini function-calling loop (chatTurn + tool dispatch, max N rounds)
//   3. append the assistant reply to history
//   4. push the reply (+ any Flex confirmations tools returned) to the user
//
// The LOOP lives here (not in gemini.service) because it must execute tool
// handlers — linebot-layer code. gemini.chatTurn is a pure single HTTP call.
//
// Function-calling contract (verified empirically against gemini-2.5-flash on
// the v1beta endpoint): a model turn's parts may carry `functionCall`; each
// such part also carries an opaque `thoughtSignature` (thinking model) that we
// MUST echo back on the matching functionResponse to keep reasoning intact.
// We send: [model: functionCall+thoughtSignature][user: functionResponse+thoughtSignature]
// and loop. When a turn has no functionCall (just text), that text is the reply.
//
// Push vs reply: replyTokens expire in ~30s and the LLM round-trip can exceed
// that. To keep the read-marker working, handle()/handleImage() race the LLM
// call against a deadline — if the model is slow, we consume the reply token
// with a brief ack BEFORE it expires (marking the user's message as read), then
// deliver the real answer via pushMessage. replyOrPush still prefers a free
// replyMessage whenever the token is alive at response time.

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { config } from '../config.js'
import { logger } from '../logger.js'
import * as store  from './conversationStore.service.js'
import * as gemini from '../services/gemini.service.js'
import * as line   from './lineMessaging.service.js'
import * as tools  from './tools/index.js'
import * as roomsRepo     from '../db/repositories/rooms.repo.js'
import * as roomImages    from '../db/repositories/roomImages.repo.js'
import { alertAdmins } from './adminAlert.service.js'
import { menuQuickReply, zoneQuickReply } from './flexMessages.js'
import * as zonesRepo from '../db/repositories/zones.repo.js'

const MAX_TOOL_ROUNDS = 5

const SYSTEM_PROMPT = [
  'คุณเป็น "น้องห้อง" แอดมินของเว็บไซต์หาห้องเช่า "Room Match" ที่คุยกับผู้ใช้ผ่านแชท LINE',
  'Room Match เป็นตัวกลางระหว่าง "ผู้เช่า" และ "ผู้ปล่อยเช่า" — ทั้งคู่ติดต่อแอดมินผ่าน LINE',
  '',
  'กฎการตอบ (ทำตามทุกข้อ):',
  '1. [ภาษา — กฎสำคัญที่สุด] ตอบภาษาเดียวกับที่ผู้ใช้พิมพ์เท่านั้น: ผู้ใช้พิมพ์อังกฤษ ต้องตอบอังกฤษ / ผู้ใช้พิมพ์ไทย ต้องตอบไทย — ถึงแม้ข้อมูลห้องและ FAQ ในระบบจะเป็นภาษาไทย ก็ต้องตอบ/แปลเป็นภาษาของผู้ใช้เสมอ คำตอบสั้น กระชับ เป็นกันเอง (ภาษาไทยใช้ "ค่ะ/นะคะ") ใช้ emoji ไม่เกิน 1 ตัวต่อข้อความ',
  '   ✦ Line แสดงข้อความเป็น plain text (ไม่่่อ่าน markdown): ตอบเป็นข้อความธรรมดาเท่านั้น — ห้ามใช้ *, **, _, #, `, หรือใช้ * หรือ - นำหน้าบรรทัดเพื่อทำลิสต์; ถ้าจะแสดงรายการห้องหลายห้อง ใช้ "•" นำหน้าแต่ละห้อง หรือขึ้นบรรทัดใหม่เฉยๆ ห้ามมี * โผล่ในคำตอบเด็ดขาด',
  '   ✦ ห้ามเขียน XML/HTML/โครงสร้างการ์ด ในคำตอบเด็ดขาด — ห้ามพิมพ์ <LINE_FLEX_CARD...>, <TITLE>, <BUTTON_...>, <IMAGE_URL> หรือ tag ใดๆ และห้ามพิมพ์ URL เอง: การ์ด/Flex/ปุ่ม/ลิงก์ฟอร์ม ระบบส่งให้ผู้ใช้อัตโนมัติจาก tool (ผู้ใช้จะเห็นการ์ดจริงปรากฏขึ้นมา) — หน้าที่น้องห้องคือพิมพ์ประโยคไทยสั้นๆ นำทางอย่างเดียว เช่น "กดกรอกฟอร์มด้านล่างได้เลยค่ะ 😊" แล้วจบ',
  '2. [ขอบเขต] ตอบเฉพาะเรื่องของ Room Match คือ หา/เช่า/ปล่อยห้อง นัดชมห้อง รายละเอียดห้อง และนโยบาย/กระบวนการของแพลตฟอร์ม — หากผู้ใช้ถามนอกขอบเขต (เช่น ความรู้ทั่วไป ข่าว สภาพอากาศ สินค้า/บริการอื่น การบ้าน/โค้ด ฯลฯ) ให้ปฏิเสธเป็นมิตรแล้วชวนกลับมาที่เรื่องห้องเช่า ห้ามตอบคำถามนอกขอบเขตด้วยข้อมูลทั่วไปโดยเด็ดขาด และห้ามเรียก escalateToAdmin เพียงเพราะเป็นคำถามนอกขอบเขต (แค่ตอบปฏิเสธสั้นๆ แล้วชวนกลับ ไม่ต้องส่งต่อแอดมิน)',
  '3. ห้ามแต่งข้อมูล ราคา สถานที่ หรือเงื่อนไขขึ้นเอง — ดึงข้อมูลจริงผ่าน tool เท่านั้น',
  '4. อนุมานเองจากข้อความว่าผู้ใช้เป็น "ผู้เช่า" หรือ "ผู้ปล่อยเช่า" ไม่ต้องถาม',
  '   - ผู้เช่า: อยากหา/ดู/นัดชมห้อง หรือถามคำถามทั่วไปเกี่ยวกับการเช่า',
  '   - ผู้ปล่อยเช่า: อยากลงประกาศห้อง อัปโหลดรูป หรือแก้รายละเอียดห้อง',
  '5. [ห้ามลาก่อน/ขอตัว] น้องห้องพร้อมช่วยเรื่องห้องเช่าตลอดเวลา — ห้ามพูดว่า "ขอตัวก่อน" "ขอตัว" "ไปก่อน" "ลาก่อน" "ไว้คุยกันใหม่" หรือทำทีจะลาไป/ไม่อยู่ต่อ ไม่ว่ากรณีใดๆ ถ้าผู้ใช้บอกว่าไม่มีอะไรแล้ว/เรียบร้อยแล้ว/ขอบคุณ/บาย/ไม่เป็นไร ให้ตอบสั้นๆ อบอุ่นๆ ว่าพร้อมช่วยเสมอ เช่น "ยินดีช่วยเสมอค่ะ 😊 มีเรื่องห้องเช่าเมื่อไหร่พิมพ์มาได้เลยนะคะ" อย่าทำให้ผู้ใช้รู้สึกว่าน้องห้องจะไปไหน',
  '',
  'เครื่องมือที่มี (เลือกใช้ tool ที่เหมาะสม ถ้าเป็นแค่ทักทาย/คุยทั่วไปให้ตอบข้อความธรรมดา ไม่ต้องเรียก tool):',
  '- searchRooms: ผู้เช่าอยากหา/ดู/เลือกห้อง — เรียกเสมอเมื่อผู้ใช้อยากเห็นห้อง แม้ไม่ได้ระบุเงื่อนไขเลย (เช่น "ขอดูห้องว่าง" "มีห้องอะไรบ้าง" "อยากดูห้อง") ให้เรียกโดยไม่ส่ง parameter เพื่อแสดงห้องแนะนำให้เลือกดูเลย อย่าถามรายละเอียดก่อน; ถ้าผู้ใช้ระบุเงื่อนไข ให้กรอก location(ชื่อย่านไทยหรืออังกฤษ) minPrice/maxPrice(บาทต่อเดือน) beds(จำนวนห้องนอนขั้นต่ำ) propertyType(condo/house/townhouse/apartment/studio)',
  '- getRoomDetails: ผู้เช่าอยากดูรายละเอียดห้องใดห้องหนึ่ง (ต้องมี roomId — ถ้าผู้ใช้ไม่ได้ระบุ ให้ถาม หรือเรียก searchRooms ก่อนแล้วเสนอห้อง)',
  '- getFaqAnswer: ถามเรื่องนโยบาย/กระบวนการ เช่น จ่ายค่าเช่าเมื่อไหร่ มัดจำ เอกสาร เงื่อนไข — เมื่อได้คำตอบ ให้ "ส่งคำตอบนั้นให้ผู้ใช้เป็นข้อความเดิมทั้งหมด ห้ามตัดทอนหรือสรุปย่อ"',
  '- scheduleViewing: ผู้เช่าอยากนัดชมห้อง — เครื่องมือนี้จะแสดงเวลาที่เปิดให้จองเป็นปุ่มให้ผู้ใช้กดเลือกเอง (ส่งแค่ roomId มาพอ) ถ้าผลลัพธ์บอก hasSlots:false ให้แจ้งว่ายังไม่มีเวลาว่าง แอดมินจะติดต่อกลับ และห้ามถามให้ผู้ใช้พิมพ์เวลาเอง; ถ้าผู้ใช้อยากนัดชมแต่ยังไม่ได้เลือกห้อง ห้ามเรียก scheduleViewing ให้ชวนเลือกย่าน/ห้องก่อน (ระบบจะแสดงปุ่มย่านให้กดเอง)',
  (config.LIFF_LISTING_ID
    ? '- createRoomDraft: ผู้ปล่อยเช่าอยากลงประกาศห้อง — เครื่องมือนี้จะส่งฟอร์มให้กรอกใน Line (กดที่การ์ดด้านล่าง) เรียกแค่ชื่อ createRoomDraft พอ ไม่ต้องถามรายละเอียดเอง'
    : '- createRoomDraft: ผู้ปล่อยเช่าอยากลงประกาศ — ต้องมี title, zone(ย่าน), monthlyRent, beds, baths ถ้าขาดให้ถามจนครบก่อนเรียก; ผลลัพธ์ status=pending รอแอดมินอนุมัติ'),
  '- editRoomDescription: ผู้ปล่อยเช่าอยากแก้รายละเอียดห้อง — น้องห้องแก้เองไม่ได้ จะส่งเรื่องให้แอดมิน (tool นี้ส่งต่อเสมอ ไม่ได้แก้จริง)',
  '- escalateToAdmin: กรณีที่น้องห้องช่วยไม่ได้ (เรื่องในขอบเขตที่ต้องให้คนดำเนินการ เช่น เรื่องพิเศษ/ร้องเรียน) หรือ getFaqAnswer บอก found=false — ส่งต่อให้แอดมิน (ห้ามใช้กับคำถามนอกขอบเขต ให้ปฏิเสธตามกฎข้อ 2)',
  '',
  'หลังเรียก tool แล้ว ใช้ผลลัพธ์ตอบผู้ใช้เป็นภาษาเดียวกับผู้ใช้สั้นๆ ห้ามเผยรายละเอียดเชิงเทคนิค (เช่น คะแนน similarity, โครงสร้าง JSON) ให้ผู้ใช้โดยไม่จำเป็น',
  '   ✦ ห้ามพิมพ์ ID/หมายเลขห้องในคำตอบเด็ดขาด — ห้ามมี "(ID: 4)", "ID 4", "ห้อง #4", "ห้องหมายเลข 4" หรือเลข roomId ใดๆ; รายละเอียดห้องอยู่ในการ์ด Flex ไม่ต้องเอาเลขมาบอก',
  '6. [การ์ดแสดงรายละเอียดให้] ยังต้องเรียก tool เสมอ (searchRooms / scheduleViewing / createRoomDraft) เพื่อให้การ์ดปรากฏ — แต่เมื่อ tool ส่งการ์ด/carousel ไปแล้ว ห้ามพิมพ์รายการห้องหรือรายละเอียดซ้ำในข้อความ ให้พิมพ์แค่ประโยคนำสั้นๆ บรรทัดเดียวแล้วจบ เช่น "มีห้องว่างให้เลือก 5 ห้องค่ะ กดดูรายละเอียดได้เลยนะคะ 👇" ผู้ใช้จะเห็นการ์ดขึ้นเองด้านล่าง (ห้ามข้ามการเรียก tool — ถ้าไม่เรียก การ์ดจะไม่ขึ้น ผู้ใช้จะเห็นแค่ข้อความ)',
  '',
  'REMINDER — ทบทวนกฎ 6 ข้อที่ห้ามลืม:',
  ' • ภาษา: ถ้าผู้ใช้พิมพ์ภาษาอังกฤษ คุณต้องตอบเป็นภาษาอังกฤษเท่านั้น (even if the room/FAQ data is in Thai).',
  ' • ขอบเขต: คำถามนอกขอบเขต (ไม่เกี่ยวกับห้องเช่า) ต้องปฏิเสธเป็นมิตรแล้วชวนกลับ ห้ามตอบและห้ามส่งต่อแอดมิน',
  ' • ห้ามลาก่อน/ขอตัว: พร้อมช่วยเสมอ — ผู้ใช้บอกว่าไม่มีอะไรแล้ว/บาย ให้ตอบว่ายินดีช่วยเสมอ ห้ามขอตัว/ลา',
  ' • ห้าม markdown/ XML: Line เป็น plain text — ห้าม *, **, _, #, ` และห้าม * นำหน้าบรรทัด; ใช้ • สำหรับรายการห้อง',
  ' • ห้ามพิมพ์โครงสร้างการ์ด/URL เอง: การ์ดและลิงก์ฟอร์มระบบส่งให้อัตโนมัติจาก tool — น้องห้องพิมพ์แค่ประโยคไทยสั้นๆ นำทาง (ห้าม <LINE_FLEX_CARD...> หรือ tag/URL ใดๆ ในคำตอบ)',
  ' • การ์ดแสดงรายละเอียดให้แล้ว: เมื่อ tool ส่งการ์ด/carousel ห้ามพิมพ์รายการห้องซ้ำในข้อความ — พิมพ์แค่ประโยคนำบรรทัดเดียว',
].join('\n')

/**
 * Run one conversational turn WITHOUT pushing to Line: append the user message,
 * run the function-calling loop, append the assistant reply. Returns
 * { reply, pushes, status }. Used by handle() (which then pushes) and by the
 * dev /api/line/debug/agent endpoint (dry-run).
 *
 * @param {string} lineUserId
 * @param {string} text
 * @returns {Promise<{reply:string|null, pushes:object[], status:string}>}
 */
export async function runOnce(lineUserId, text) {
  if (!lineUserId || !text || typeof text !== 'string') {
    return { reply: null, pushes: [], status: 'bad_input' }
  }
  if (!gemini.isConfigured()) {
    return { reply: null, pushes: [], status: 'not_configured' }
  }
  const trimmed = text.trim()
  if (!trimmed) return { reply: null, pushes: [], status: 'bad_input' }

  // "typing…" indicator — best-effort; never fatal.
  line.startLoading?.(lineUserId, 20).catch(() => {})

  const { history } = await store.append(lineUserId, 'user', trimmed)
  const { reply: rawReply, pushes } = await runAgentLoop({ lineUserId, history })
  // Sanitise BEFORE storing + returning: Line renders plain text, so markdown
  // (**bold**, *italic*, # heading, `code`, list markers) shows literally.
  // Strip it deterministically — the model keeps slipping `**` back in despite
  // the prompt rule. Also keeps history clean so the model stops seeing its own
  // markdown on later turns.
  const reply = rawReply ? stripMarkdown(rawReply) : rawReply
  if (reply) await store.append(lineUserId, 'assistant', reply)
  else logger.warn({ lineUserId, inLen: trimmed.length }, 'agent loop returned no reply')
  return { reply, pushes, status: reply ? 'ok' : 'no_reply' }
}

/**
 * Conservative "show me available rooms" intent detector — used ONLY to force
 * the searchRooms tool on round 0 so the room carousel always appears. Narrow
 * by design: only obvious room-browsing phrasing. Booking a viewing, listing,
 * editing, uploading photos, or referencing a specific room id are NOT matched
 * (those have other tools / the model decides). False negatives are fine — the
 * model still calls searchRooms most of the time; this just plugs the gap where
 * it skips.
 */
function wantsRoomSearch(text) {
  const t = String(text || '').toLowerCase().trim()
  if (!t) return false
  // Belongs to another tool/flow → don't force searchRooms.
  if (/นัดชม|เข้าชม|จอง|ลงประกาศ|ปล่อยห้อง|ลงห้อง|แก้รายละเอียด|แก้ห้อง|อัปโหลดรูป|ส่งรูป|list.{0,12}room|post.{0,12}room|edit/.test(t)) return false
  // A specific room reference → getRoomDetails, not a browse.
  if (/ดูห้อง\s*#?\s*\d|ห้อง\s*#?\s*\d|room\s*#?\s*\d/.test(t)) return false
  // Obvious room-browsing intent (Thai + English), incl. filtered ("ห้องอ่อนนุก").
  return /ดูห้อง|ห้องว่าง|หาห้อง|มีห้อง|เช่าห้อง|ห้องเช่า|แนะนำห้อง|เลือกห้อง|ห้องใกล้|ห้องย่าน|ห้อง.+ย่าน|show.{0,20}room|available.{0,20}room|find.{0,20}room|search.{0,20}room|browse.{0,20}room/.test(t)
}

/**
 * Strip markdown that Line would render as literal characters (Line is plain
 * text). Order matters: remove ** before *, etc. Conservative — room copy
 * rarely contains literal *, _, #, or backticks.
 */
function stripMarkdown(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
    .replace(/`([^`\n]+)`/g, '$1')        // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')     // **bold**
    .replace(/__([^_]+)__/g, '$1')         // __bold__
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')   // *italic*
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')     // _italic_
    .replace(/^#{1,6}\s+/gm, '')           // headings
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')   // -, *, + list markers → •
    .replace(/\s{3,}/g, '  ')              // collapse long runs of spaces
}

/**
 * Handle a text message from a Line user (the webhook path). Runs the turn and
 * pushes the reply (+ any Flex confirmations tools returned) to the user.
 *
 * @param {string} lineUserId
 * @param {string} text
 * @param {string} [replyToken]  From the inbound webhook. Used to send the reply
 *   as a FREE replyMessage (LINE's free quota) instead of a metered pushMessage
 *   — see lineMessaging.replyOrPush().
 * @returns {Promise<{reply:string}|null>}
 */
export async function handle(lineUserId, text, replyToken = null) {
  // Race the reply token against the LLM call. If Gemini is slow (>3s),
  // raceReplyToken fires a brief ack that consumes the token (marking the
  // user's message as read) before it expires at ~30s. finish() then returns
  // null so the real answer goes via push instead of a dead reply token.
  const racer = line.raceReplyToken(lineUserId, replyToken)

  // Typing indicator — non-blocking, best-effort. Shows "..." in the user's
  // chat for up to 25s while the LLM is thinking.
  line.startLoading(lineUserId, 25).catch(() => {})

  let r
  try {
    r = await runOnce(lineUserId, text)
  } catch (err) {
    logger.error({ err, lineUserId }, 'chat agent handle failed')
    await line.replyOrPush(lineUserId, racer.finish(), 'ขออภัยค่ะ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งค่ะ')
    return null
  }

  if (r.status === 'not_configured') {
    await line.replyOrPush(lineUserId, racer.finish(), 'ขออภัยค่ะ ระบบยังไม่ได้ตั้งค่า AI กรุณาลองใหม่ภายหลัง')
    return null
  }
  if (!r.reply) {
    // A side-effecting tool (createRoomDraft / scheduleViewing) may have
    // committed its DB write AND queued a confirmation card even though we
    // couldn't produce a text reply. Deliver those FIRST so the user sees the
    // action succeeded and doesn't blindly retry (which would duplicate the
    // draft/viewing). Only prompt a retry when nothing was actually done.
    await line.replyOrPush(lineUserId, racer.finish(), [
      ...r.pushes,
      r.pushes.length
        ? 'เสร็จเรียบร้อยค่ะ แต่น้องห้องตอบข้อความไม่ได้ชั่วคราว หากมีปัญหาแจ้งได้นะคะ'
        : 'ขออภัยค่ะ ระบบตอบกลับไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง',
    ])
    return null
  }

  // Show a zone picker when the tenant wants to book a viewing but hasn't named
  // a room yet (pick a zone → see rooms → tap อยากนัดชม on one → book).
  // Otherwise the standard floating menu.
  const wantsViewing = /นัดชม|เข้าชม/.test(text) && !/\d/.test(text)
  const quickReply = wantsViewing
    ? zoneQuickReply(await zonesRepo.findAll())
    : menuQuickReply()
  // Reply text first, then any tool cards — bundled into one free reply
  // (or push, if the early ack already consumed the token).
  await line.replyOrPush(lineUserId, racer.finish(), [
    { type: 'text', text: r.reply, quickReply },
    ...r.pushes,
  ])

  logger.info(
    { lineUserId, outLen: r.reply.length, pushes: r.pushes.length },
    'chat agent replied (tools)',
  )
  return { reply: r.reply }
}

/**
 * The function-calling loop. Builds the contents from history, calls chatTurn,
 * executes any returned functionCalls, feeds results back, and repeats until the
 * model produces a text reply (or we hit the round cap).
 *
 * @returns {Promise<{reply:string|null, pushes:object[]}>}
 */
async function runAgentLoop({ lineUserId, history }) {
  const ctx = { lineUserId, logger }
  let contents = buildContents(history)
  const pushes = []
  let retriedEmpty = false
  const lastUserText = history.length ? history[history.length - 1].content : ''

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Round 0: if the user is clearly asking to browse rooms, FORCE searchRooms
    // so the carousel always appears. The model otherwise sometimes skips the
    // tool (now that it only writes a one-line intro) and the user would see a
    // text intro with no rooms. Later rounds stay AUTO.
    const forceSearch = (round === 0 && wantsRoomSearch(lastUserText))
    const turn = await gemini.chatTurn({
      contents,
      tools: tools.DECLARATIONS,
      toolConfig: forceSearch
        ? { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['searchRooms'] } }
        : { functionCallingConfig: { mode: 'AUTO' } },
    })

    if (!turn.ok) {
      logger.warn({ lineUserId, status: turn.status, error: turn.error, round }, 'chatTurn failed in loop')
      return { reply: null, pushes }
    }

    const fcs = Array.isArray(turn.functionCalls) ? turn.functionCalls : []
    if (fcs.length === 0) {
      const text = turn.text && turn.text.trim() ? turn.text.trim() : null
      if (text) return { reply: text, pushes }
      // Empty turn — a thinking model occasionally emits no visible text or
      // functionCall (e.g. when truncated by the output-token cap). Give it one
      // more shot before giving up, so the user rarely sees "ระบบตอบกลับไม่ได้".
      if (retriedEmpty) return { reply: null, pushes }
      logger.warn({ lineUserId, round, finishReason: turn.finishReason, usage: turn.usage }, 'empty model turn — retrying once')
      retriedEmpty = true
      continue
    }
    retriedEmpty = false // got a real (tool-calling) turn — reset the retry budget

    // Execute every functionCall this turn, then build the two turns to append:
    // a model turn echoing the calls (+thoughtSignature) and a user turn with
    // the functionResponses (+thoughtSignature). Order is preserved.
    const modelParts = []
    const userParts = []
    for (const fc of fcs) {
      logger.info({ lineUserId, tool: fc.name, args: fc.args, round }, 'agent calling tool')
      const result = await tools.dispatch(fc.name, fc.args, ctx)
      if (result && Array.isArray(result._push)) pushes.push(...result._push)
      const { _push, ...response } = result
      const sig = fc.thoughtSignature ? { thoughtSignature: fc.thoughtSignature } : {}
      modelParts.push({ functionCall: { name: fc.name, args: fc.args }, ...sig })
      // functionResponse.response MUST be a JSON object.
      userParts.push({ functionResponse: { name: fc.name, response: response ?? {} }, ...sig })
    }
    contents = [
      ...contents,
      { role: 'model', parts: modelParts },
      { role: 'user', parts: userParts },
    ]
  }

  logger.warn({ lineUserId, pushes: pushes.length }, 'agent loop hit round cap without a text reply')
  // If a side-effecting tool already ran, acknowledge the partial completion
  // rather than a generic "try again" (which would sit next to a success card
  // and invite a duplicate-creating resubmit).
  return {
    reply: pushes.length
      ? 'น้องห้องดำเนินการให้บางส่วนเรียบร้อยแล้วค่ะ รบกวนรอแอดมินตรวจสอบ หรือถามเพิ่มเติมได้นะคะ'
      : 'ขออภัยค่ะ ระบบประมวลผลนานเกินไป รบกวนลองใหม่อีกครั้งนะคะ',
    pushes,
  }
}

/**
 * The system prompt with today's date appended, so the model can resolve
 * relative dates in Thai ("พรุ่งนี้", "สัปดาห์หน้า", "วันจันทร์หน้า") for the
 * scheduleViewing tool. Date is formatted in Asia/Bangkok (ICT, UTC+7) so it is
 * correct regardless of the server's own timezone.
 */
function systemWithDate() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
  const dow = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Bangkok', weekday: 'long' })
  return `${SYSTEM_PROMPT}\n\n---\n\n(ข้อมูลปัจจุบัน: วันนี้คือ ${today} (${dow}) เวลาไทย ICT UTC+7 — ใช้เพื่อคำนวณวันเวลาสัมพัทธ์ เช่น "พรุ่งนี้" "สัปดาห์หน้า" ให้ถูกต้อง)`
}

/**
 * Translate our stored history `{role,content,ts}[]` into Gemini's `contents`
 * shape and inline the system prompt into the first user turn (the v1 endpoint
 * rejects a top-level systemInstruction field; inlining is the established pattern).
 */
function buildContents(history) {
  const system = systemWithDate()
  const turns = (Array.isArray(history) ? history : [])
    .filter((m) => m && m.content != null && String(m.content).trim() !== '')
    .map((m) => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content).slice(0, 4000) }],
    }))

  if (turns.length === 0) {
    return [{ role: 'user', parts: [{ text: system }] }]
  }
  if (turns[0].role === 'user') {
    turns[0].parts[0].text = `${system}\n\n---\n\n${turns[0].parts[0].text}`
  } else {
    turns.unshift({ role: 'user', parts: [{ text: system }] })
  }
  return turns
}

/**
 * Handle an image message from a Line user (a landlord sending room photos).
 * Attaches the image to the user's most recent pending draft, or escalates to
 * admin if there is no draft to attach it to.
 *
 * @param {string} lineUserId
 * @param {string} messageId  Line message id (used to fetch the bytes)
 * @param {string} [replyToken]  Used to send confirmations as a FREE reply.
 * @returns {Promise<{roomId:number}|null>}
 */
export async function handleImage(lineUserId, messageId, replyToken = null) {
  if (!lineUserId || !messageId) return null
  // Image handling is usually fast (no LLM), but the token racer keeps the
  // read marker working if the image download is slow.
  const racer = line.raceReplyToken(lineUserId, replyToken, {
    ackMessage: 'น้องห้องกำลังรับรูปภาพ รอสักครู่...',
  })
  try {
    const draft = await roomsRepo.findPendingByLineUser(lineUserId)
    if (!draft) {
      await alertAdmins({
        lineUserId,
        reason: 'upload-photos',
        summary: 'ได้รับรูปภาพจากผู้ใช้ แต่ยังไม่มีประกาศห้องที่รออนุมัติ',
        originalPayload: { messageId },
      })
      await line.replyOrPush(lineUserId, racer.finish(),
        'ยังไม่มีประกาศห้องที่รออนุมัติในระบบค่ะ ส่งรูปนี้ให้แอดมินดูแล้ว หากต้องการปล่อยห้อง พิมพ์บอกรายละเอียดห้องก่อนได้เลยนะคะ')
      return null
    }

    const { buffer, contentType, filename } = await line.downloadImage(messageId)
    const ext = extFromNameType(filename, contentType)
    const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`
    const dir = path.join(process.cwd(), 'uploads', 'rooms', String(draft.id))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, fileName), buffer)

    const base = config.APP_BASE_URL || `http://localhost:${config.PORT}`
    const publicUrl = `${base}/uploads/rooms/${draft.id}/${fileName}`
    await roomImages.create(draft.id, publicUrl, fileName)

    await line.replyOrPush(lineUserId, racer.finish(), `ได้รับรูปภาพสำหรับห้อง "${draft.title}" เรียบร้อยค่ะ 📸`)
    logger.info({ lineUserId, roomId: draft.id }, 'attached room photo via Line')
    return { roomId: draft.id }
  } catch (err) {
    logger.error({ err, lineUserId }, 'chat agent handleImage failed')
    await line.replyOrPush(lineUserId, racer.finish(), 'ขออภัยค่ะ รับรูปภาพไม่สำเร็จ รบกวนลองส่งใหม่อีกครั้งนะคะ')
    return null
  }
}

function extFromNameType(filename, contentType) {
  const fromName = filename ? path.extname(filename) : ''
  if (fromName) return fromName
  if (contentType?.includes('png'))  return '.png'
  if (contentType?.includes('webp')) return '.webp'
  if (contentType?.includes('gif'))  return '.gif'
  return '.jpg'
}

// Outbound delivery is centralised in lineMessaging.replyOrPush() (prefers a
// FREE replyMessage using the webhook reply token, falls back to metered
// push). See handle() / handleImage() call sites.
