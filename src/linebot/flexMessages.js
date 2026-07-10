// src/linebot/flexMessages.js — Line Flex Message builders for the chatbot.
//
// Used as richer cards pushed ALONGSIDE the model's text reply. The agent loop
// collects `_push` arrays returned by tool handlers (and strips that key before
// forwarding the result to Gemini) and pushes them after the text reply.
//
// Two families:
//   1) Rich room/slot/LIFF cards (Feature A/B/C): roomCard/roomCarousel,
//      slotCarousel, listingFormCard.
//   2) Simple confirmation cards: viewingConfirmation, pendingListing, welcome.

import { config } from '../config.js'

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

function rentText(n) {
  const v = Number(n ?? 0)
  return `฿${v.toLocaleString('en-US')}/เดือน`
}

/** A single room as a Flex bubble (hero image + specs + อยากนัดชม/ดูรายละเอียด buttons). */
export function roomCard(room = {}) {
  const specs = [
    room.beds != null ? `${room.beds} ห้องนอน` : '',
    room.baths != null ? `${room.baths} ห้องน้ำ` : '',
    room.sqm != null ? `${room.sqm} ตร.ม.` : '',
    room.propertyType ? PROPERTY_LABEL[room.propertyType] || room.propertyType : '',
  ].filter(Boolean).join(' · ')

  const body = {
    type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: room.title || 'ห้องเช่า', weight: 'bold', size: 'lg', wrap: true, color: '#1A1A1A' },
      { type: 'text', text: rentText(room.price), weight: 'bold', size: 'md', color: '#0A7C3B' },
      ...(specs ? [{ type: 'text', text: specs, size: 'sm', color: '#6B7280', wrap: true }] : []),
      ...(room.zone ? [{ type: 'text', text: `ย่าน${room.zone}`, size: 'sm', color: '#6B7280' }] : []),
    ],
  }
  // ดูรายละเอียด opens the room's page on the website when a web origin is
  // configured (WEB_BASE_URL, falling back to APP_BASE_URL). Line URI buttons
  // accept http too, so http://localhost works for local testing (images are the
  // only thing that strictly needs https). With no origin it falls back to a
  // message action that triggers getRoomDetails in chat.
  const webOrigin = config.WEB_BASE_URL || config.APP_BASE_URL
  const detailAction = webOrigin && /^https?:\/\//i.test(webOrigin)
    ? { type: 'uri', label: 'ดูรายละเอียด', uri: `${webOrigin.replace(/\/+$/, '')}/rooms/${room.id}` }
    : { type: 'message', label: 'ดูรายละเอียด', text: `ดูห้อง ${room.id}` }

  const footer = {
    type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'button', style: 'primary', color: '#1F4068',
        action: { type: 'message', label: 'อยากนัดชม', text: `อยากนัดชมห้อง ${room.id}` } },
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
export function roomCarousel(rooms = []) {
  const list = (Array.isArray(rooms) ? rooms : []).slice(0, 5)
  if (list.length === 0) return null
  if (list.length === 1) {
    return { type: 'flex', altText: `ห้องเช่า: ${list[0].title || ''}`, contents: roomCard(list[0]) }
  }
  return {
    type: 'flex',
    altText: `มีห้องให้เลือก ${list.length} ห้อง — เปิดดูในแชท`,
    contents: { type: 'carousel', contents: list.map(roomCard) },
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
export function slotCarousel(roomTitle, slots = []) {
  const list = (Array.isArray(slots) ? slots : []).slice(0, 10)
  if (list.length === 0) return null
  const bubble = (s) => ({
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'text', text: roomTitle || 'นัดชมห้อง', weight: 'bold', wrap: true, color: '#1A1A1A' },
        { type: 'text', text: 'เวลาที่เปิดให้นัด', size: 'xs', color: '#6B7280' },
        { type: 'text', text: bangkok(s.startsAt || s.starts_at), weight: 'bold', size: 'lg', color: '#0A7C3B', wrap: true },
      ],
    },
    footer: {
      type: 'box', layout: 'vertical', contents: [
        { type: 'button', style: 'primary', color: '#1F4068',
          action: { type: 'postback', label: 'จองเวลานี้', data: `action=book&slotId=${s.id}`, displayText: 'จองเวลานี้' } },
      ],
    },
  })
  if (list.length === 1) {
    return { type: 'flex', altText: `เวลานัดชม: ${bangkok(list[0].startsAt || list[0].starts_at)}`, contents: bubble(list[0]) }
  }
  return {
    type: 'flex',
    altText: `เลือกเวลานัดชมห้อง — ${list.length} ช่วง`,
    contents: { type: 'carousel', contents: list.map(bubble) },
  }
}

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
        roomId ? `เลขห้อง: ${roomId}` : '',
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
