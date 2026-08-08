// src/linebot/flexMessages.js — Line Flex Message builders for the chatbot.
//
// Used as richer cards pushed ALONGSIDE the model's text reply. The agent loop
// collects `_push` arrays returned by tool handlers (and strips that key before
// forwarding the result to Gemini) and pushes them after the text reply.
//
// Two families:
//   1) Rich room/slot/LIFF cards (Feature A/B/C): roomCard/roomCarousel,
//      listingFormCard.
//   2) Simple confirmation cards: viewingConfirmation, pendingListing, welcome.

import { config } from '../config.js'
import { maskRoomCode, maskCodeInText } from './roomCode.js'

const TZ = 'Asia/Bangkok'

// Format an ISO datetime as a Thai, Bangkok-time string for cards.
function bangkok(iso, opts = { dateStyle: 'long', timeStyle: 'short' }) {
  try {
    return new Date(iso).toLocaleString('th-TH', { timeZone: TZ, ...opts })
  } catch {
    return iso
  }
}

// ---------------------------------------------------------------------------
// Room cards (Feature A — search results carousel)
// ---------------------------------------------------------------------------

const PROPERTY_LABEL = {
  condo: 'คอนโด', house: 'บ้าน', townhouse: 'ทาวน์เฮ้าส์', apartment: 'อพาร์ตเมนต์', studio: 'สตูดิโอ',
}

/**
 * Resolve a room image URL to one Line's Flex will accept, or null to omit the
 * hero. Line REQUIRES an absolute https URL for image components — a relative
 * path (the seeded demo images like "/images/room-navy.jpg") or an http/localhost
 * URL makes Line reject the ENTIRE Flex push, and that error is swallowed by
 * safePush, so one bad image = the card silently never appears.
 *
 *   - absolute https           → use as-is
 *   - absolute http            → null (Line rejects non-https)
 *   - relative ("/images/…")   → prefix with config.APP_BASE_URL (the backend
 *                                 serves /images and /uploads), else null
 */
function resolveHeroUrl(image) {
  if (!image) return null
  const raw = String(image)
  if (/^https:\/\//i.test(raw)) return raw
  if (/^http:\/\//i.test(raw)) return null
  if (!config.APP_BASE_URL) return null
  const abs = `${config.APP_BASE_URL.replace(/\/+$/, '')}${raw.startsWith('/') ? '' : '/'}${raw}`
  return /^https:\/\//i.test(abs) ? abs : null
}

function rentText(n, lang = 'th') {
  const v = Number(n ?? 0)
  return `฿${v.toLocaleString('en-US')}${cardCopy(lang).rentSuffix}`
}

/**
 * Quick Reply chips attached to the bot's replies — a "floating menu" so users
 * on Line for desktop (who can't see the Rich Menu) always have the main
 * actions one tap away. Each message-type chip sends a phrase the agent routes
 * to the right tool; the website chip is a URI (only when WEB_BASE_URL is set).
 * Returns the `{ items }` object to spread onto a message's `quickReply`.
 */
export function menuQuickReply() {
  const items = [
    { type: 'action', action: { type: 'message', label: '🔍 หาห้องเช่า',  text: 'ขอดูห้องว่าง' } },
    { type: 'action', action: { type: 'message', label: '🏠 ลงประกาศ',    text: 'อยากลงประกาศห้อง' } },
    { type: 'action', action: { type: 'message', label: '📅 นัดชมห้อง',   text: 'อยากนัดชมห้อง' } },
    { type: 'action', action: { type: 'message', label: '💬 ถามแอดมิน',  text: 'ติดต่อแอดมิน' } },
  ]
  if (config.WEB_BASE_URL) {
    items.push({ type: 'action', action: { type: 'uri', label: '🌐 เว็บไซต์', uri: config.WEB_BASE_URL } })
  }
  return { items }
}

/**
 * Zone picker chips — shown when a tenant wants to book a viewing but hasn't
 * chosen a room yet. Each chip searches that zone ("ดูห้องว่างย่าน…") so they can
 * pick a room, then tap อยากนัดชม on it to book. Pass the zones from zones.repo
 * (rows with `name_th`). Max 12 (Line's quick-reply ceiling is 13).
 */
export function zoneQuickReply(zones = []) {
  const items = (Array.isArray(zones) ? zones : []).slice(0, 12).map((z) => ({
    type: 'action',
    action: { type: 'message', label: `📍 ${z.name_th}`, text: `ดูห้องว่างย่าน${z.name_th}` },
  }))
  return { items }
}


// Card copy in both languages. The model never sees these — Flex is built here
// and pushed straight to LINE — so without this an English speaker gets a fluent
// English reply followed by a Thai room card.
const CARD = {
  th: {
    room: 'ห้อง', rentSuffix: '/เดือน', zonePrefix: 'ย่าน',
    beds: 'ห้องนอน', baths: 'ห้องน้ำ', sqm: 'ตร.ม.',
    fallbackTitle: 'ห้องเช่า',
    book: 'อยากนัดชม', details: 'ดูรายละเอียด',
    bookText: (c) => (c ? `อยากนัดชมห้อง ${c}` : 'อยากนัดชมห้องนี้'),
    detailText: (c) => (c ? `ขอดูรายละเอียดห้อง ${c}` : 'ขอดูรายละเอียดห้องนี้'),
    altOne: (t) => `ห้องเช่า: ${t}`,
    altMany: (n) => `มีห้องให้เลือก ${n} ห้อง — เปิดดูในแชท`,
  },
  en: {
    room: 'Unit', rentSuffix: '/month', zonePrefix: '',
    beds: 'bed', baths: 'bath', sqm: 'sqm',
    fallbackTitle: 'Room for rent',
    book: 'Book a viewing', details: 'View details',
    // The reply text is what the USER appears to send, and the bot parses it.
    // Kept in the user's own language so the transcript reads naturally; the
    // agent handles both languages.
    bookText: (c) => (c ? `I'd like to view unit ${c}` : "I'd like to view this room"),
    detailText: (c) => (c ? `Tell me more about unit ${c}` : 'Tell me more about this room'),
    altOne: (t) => `Room for rent: ${t}`,
    altMany: (n) => `${n} rooms to choose from — open in chat`,
  },
}
const cardCopy = (lang) => CARD[lang] || CARD.th

const PROPERTY_LABEL_EN = {
  condo: 'Condo', house: 'House', townhouse: 'Townhouse',
  apartment: 'Apartment', studio: 'Studio',
}

/** A single room as a Flex bubble (hero image + specs + อยากนัดชม/ดูรายละเอียด buttons). */
export function roomCard(room = {}, lang = 'th') {
  const t = cardCopy(lang)
  const specs = [
    room.beds != null ? `${room.beds} ${t.beds}` : '',
    room.baths != null ? `${room.baths} ${t.baths}` : '',
    room.sqm != null ? `${room.sqm} ${t.sqm}` : '',
    room.propertyType ? (lang === 'en' ? PROPERTY_LABEL_EN[room.propertyType] : PROPERTY_LABEL[room.propertyType]) || room.propertyType : '',
  ].filter(Boolean).join(' · ')

  const shownCode = maskRoomCode(room.roomCode)
  // Admins often put the unit number in the title ("Kave Pop Salaya - A0707"),
  // which would hand back the very code the line below it is hiding.
  const shownTitle = maskCodeInText(room.title, room.roomCode) || t.fallbackTitle

  const body = {
    type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: shownTitle, weight: 'bold', size: 'lg', wrap: true, color: '#1A1A1A' },
      // Identify the room by its room number so users (and the bot) refer to a
      // room by "ห้อง A012xx" rather than an internal id. Masked — the tail of a
      // room number points at a real unit and the customer doesn't need it.
      ...(shownCode ? [{ type: 'text', text: `${t.room} ${shownCode}`, size: 'sm', color: '#6B7280', wrap: true }] : []),
      { type: 'text', text: rentText(room.price, lang), weight: 'bold', size: 'md', color: '#0A7C3B' },
      ...(specs ? [{ type: 'text', text: specs, size: 'sm', color: '#6B7280', wrap: true }] : []),
      ...(room.zone ? [{ type: 'text', text: `${t.zonePrefix}${lang === 'en' ? (room.zoneEn || room.zone) : room.zone}`, size: 'sm', color: '#6B7280' }] : []),
    ],
  }
  // Human-facing labels use the MASKED room number; the internal id travels
  // invisibly in the postback `data` so tool lookups stay reliable even though
  // the user never sees the id. Fall back to "ห้องนี้" when a room has no code.
  const viewingText = t.bookText(shownCode)
  const detailText  = t.detailText(shownCode)

  // ดูรายละเอียด opens the room's page on the website when a web origin is
  // configured (WEB_BASE_URL, falling back to APP_BASE_URL). With no origin it
  // falls back to a postback that triggers getRoomDetails in chat — the postback
  // shows the room number (displayText) while carrying the id (data).
  const webOrigin = config.WEB_BASE_URL || config.APP_BASE_URL
  const detailAction = webOrigin && /^https?:\/\//i.test(webOrigin)
    ? { type: 'uri', label: t.details, uri: `${webOrigin.replace(/\/+$/, '')}/rooms/${room.id}` }
    : { type: 'postback', label: t.details, data: `action=details&roomId=${room.id}`, displayText: detailText }

  const footer = {
    type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'button', style: 'primary', color: '#1F4068',
        action: { type: 'postback', label: t.book, data: `action=viewing&roomId=${room.id}`, displayText: viewingText } },
      { type: 'button', style: 'secondary', action: detailAction },
    ],
  }
  const heroUrl = resolveHeroUrl(room.image)
  const hero = heroUrl
    ? { type: 'image', url: heroUrl, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' }
    : undefined

  return { type: 'bubble', ...(hero ? { hero } : {}), body, footer }
}

/**
 * Rooms as a Flex message: a single bubble for one room, or a carousel for many
 * (Line caps carousels at 12 bubbles; we cap at 5).
 */
export function roomCarousel(rooms = [], lang = 'th') {
  const t = cardCopy(lang)
  const list = (Array.isArray(rooms) ? rooms : []).slice(0, 5)
  if (list.length === 0) return null
  if (list.length === 1) {
    return { type: 'flex', altText: t.altOne(list[0].title || ''), contents: roomCard(list[0], lang) }
  }
  return {
    type: 'flex',
    altText: t.altMany(list.length),
    contents: { type: 'carousel', contents: list.map((r) => roomCard(r, lang)) },
  }
}

// ---------------------------------------------------------------------------
// Slot carousel (Feature B — bookable viewing slots)
// ---------------------------------------------------------------------------

/**
 * Open viewing slots as a Flex carousel. Each bubble is one bookable time with a
 * postback button `action=book&slotId=<id>` (handled by the webhook postback
 * dispatcher — NOT the LLM, so booking is deterministic).
 */
// ---------------------------------------------------------------------------
// LIFF listing form card (Feature C)
// ---------------------------------------------------------------------------

/** A card with a URI button that opens the LIFF listing form inside Line. */
export function listingFormCard(liffId) {
  if (!liffId) return null
  return {
    type: 'flex',
    altText: 'ลงประกาศห้องของคุณ — กดเพื่อกรอกฟอร์ม',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', contents: [
          { type: 'text', text: 'ลงประกาศห้องของคุณ', weight: 'bold', size: 'lg', color: '#1A1A1A' },
          { type: 'text', text: 'กดปุ่มด้านล่างเพื่อกรอกฟอร์ม กรอกเสร็จแอดมินจะตรวจและอนุมัติให้ค่ะ',
            wrap: true, color: '#6B7280' },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'button', style: 'primary', color: '#1F4068',
            action: { type: 'uri', label: '📝 กรอกฟอร์มลงประกาศ', uri: `https://liff.line.me/${liffId}` } },
        ],
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Simple confirmation cards
// ---------------------------------------------------------------------------

function bubble({ title, bodyLines, footer = null }) {
  const body = {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    contents: bodyLines
      .filter((l) => l !== undefined && l !== null && l !== '')
      .map((text) => ({ type: 'text', text, wrap: true, size: 'sm', color: '#4A4A4A' })),
  }
  return {
    type: 'bubble',
    ...(title ? {
      header: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: title, weight: 'bold', size: 'lg', color: '#1A1A1A', wrap: true },
        ],
      },
    } : {}),
    body,
    ...(footer ? { footer: { type: 'box', layout: 'vertical', contents: footer } } : {}),
  }
}

/** Card pushed after a tenant books a viewing (via slot postback). */
export function viewingConfirmation({ roomTitle, scheduledFor, viewingId } = {}) {
  return {
    type: 'flex',
    altText: `ยืนยันการนัดชมห้อง${roomTitle ? `: ${roomTitle}` : ''}`,
    contents: bubble({
      title: '📅 นัดชมห้องสำเร็จ',
      bodyLines: [
        roomTitle ? `ห้อง: ${roomTitle}` : '',
        scheduledFor ? `เวลา: ${scheduledFor}` : '',
        'สถานะ: รอแอดมินยืนยันอีกครั้งค่ะ',
        viewingId ? `(เลขที่ ${viewingId})` : '',
      ],
    }),
  }
}

/** Card pushed after a landlord submits a listing (pending until admin approves). */
export function pendingListing({ title, roomId } = {}) {
  return {
    type: 'flex',
    altText: `ส่งประกาศห้องเข้าระบบแล้ว${title ? `: ${title}` : ''}`,
    contents: bubble({
      title: '🏠 ส่งประกาศเรียบร้อย',
      bodyLines: [
        title ? `ห้อง: ${title}` : '',
        // Reference number (internal id), NOT the room number — landlord chat
        // drafts don't carry a room code, so labelling this "เลขห้อง" would be
        // misleading. Admins use it to locate the pending listing.
        roomId ? `หมายเลขอ้างอิง: ${roomId}` : '',
        'สถานะ: รอแอดมินตรวจสอบ',
        'พอแอดมินอนุมัติ ห้องจะขึ้นบนเว็บทันทีค่ะ',
      ],
    }),
  }
}

/** Welcome card for the follow event (Phase 6 onboarding). */
export function welcome({ displayName } = {}) {
  return {
    type: 'flex',
    altText: 'ยินดีต้อนรับสู่ Room Match',
    contents: bubble({
      title: '👋 สวัสดีค่ะ น้องห้องยินดีให้บริการ',
      bodyLines: [
        displayName ? `คุณ ${displayName}` : '',
        'พิมพ์บอกได้เลยว่าอยาก "หาห้องเช่า" หรือ "ปล่อยห้องให้เช่า" ค่ะ',
      ],
    }),
  }
}
