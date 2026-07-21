// src/routes/liff.js — LIFF listing form (Feature C).
//
//   GET  /listing        — the fillable form served as HTML (opened inside Line
//                          via the createRoomDraft Flex card). Loads the LIFF
//                          SDK, reads the landlord's Line userId, and POSTs the
//                          same-origin FormData below.
//   POST /listing/submit — receives the form (multipart, photos included),
//                          find-or-creates the landlord, resolves the zone,
//                          inserts a status='pending' room, and saves photos.
//                          Mirrors the bot photo path in my-listings.js.
//
// Mounted unversioned (/api/liff) AND versioned (/api/v1/liff) in routes/index.js.

import { Router } from 'express'
import multer from 'multer'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { AppError }     from '../middleware/AppError.js'
import { rateLimit }    from '../middleware/rateLimit.js'
import { detectImageExt } from '../services/fileSignature.service.js'
import { config } from '../config.js'
import * as landlords   from '../db/repositories/landlords.repo.js'
import { findByName }   from '../db/repositories/zones.repo.js'
import * as rooms       from '../db/repositories/rooms.repo.js'
import * as roomImages  from '../db/repositories/roomImages.repo.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { notifyAdminGroup } from '../linebot/adminAlert.service.js'

export const liff = Router()

// multer in-memory so the handler can persist each photo itself. Mirrors
// my-listings.js: 10 MB cap per image, images only.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },   // 5 MB cap (was 10) — limits per-request memory
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new AppError(400, 'BAD_MIME', 'ต้องเป็นไฟล์รูปภาพ'))
    }
    cb(null, true)
  },
})

/**
 * Render the listing form. The LIFF id and submit URL are injected from the
 * server so the page works whether it is served at /api/liff or /api/v1/liff.
 */
function renderListingHtml(liffId, submitUrl) {
  return `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ลงประกาศห้อง — Room Match</title>
  <script charset="utf-8" src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Sarabun", sans-serif;
      background: #F4F6F8;
      color: #1A1A1A;
      padding: 16px;
    }
    .wrap { max-width: 520px; margin: 0 auto; }
    h1 { font-size: 20px; margin: 8px 0 4px; }
    .sub { color: #6B7280; font-size: 13px; margin: 0 0 16px; }
    .card {
      background: #fff;
      border-radius: 14px;
      padding: 18px 16px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    }
    label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
    .opt { font-weight: 400; color: #9CA3AF; }
    input, select, textarea {
      width: 100%; padding: 10px 12px; font-size: 15px;
      border: 1px solid #D1D5DB; border-radius: 10px; background: #fff;
    }
    textarea { resize: vertical; min-height: 80px; }
    .row { display: flex; gap: 12px; }
    .row > div { flex: 1; }
    input[type="file"] { padding: 8px; }
    .btn {
      margin-top: 18px; width: 100%; padding: 13px;
      background: #1F4068; color: #fff; border: none; border-radius: 10px;
      font-size: 16px; font-weight: 600; cursor: pointer;
    }
    .btn:disabled { background: #9CA3AF; cursor: not-allowed; }
    .status { display: none; margin-top: 14px; padding: 12px; border-radius: 10px; font-size: 14px; }
    .status.success { background: #ECFDF5; color: #065F46; display: block; }
    .status.error { background: #FEF2F2; color: #991B1B; display: block; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>ลงประกาศห้องของคุณ</h1>
    <p class="sub">กรอกข้อมูลแล้วกดส่ง แอดมินจะตรวจสอบและอนุมัติให้ค่ะ</p>
    <form id="listingForm" class="card">
      <input type="hidden" id="lineUserId" name="lineUserId" value="" />

      <label for="contactName">ชื่อเจ้าของห้อง <span class="opt">*</span></label>
      <input id="contactName" name="contactName" type="text" required placeholder="เช่น คุณสมชัย" />

      <label for="contactPhone">เบอร์โทร <span class="opt">*</span></label>
      <input id="contactPhone" name="contactPhone" type="tel" required placeholder="เช่น 081-234-5678" />

      <label for="title">ชื่อห้อง</label>
      <input id="title" name="title" type="text" required placeholder="เช่น คอนโด ใกล้ BTS" />

      <label for="zone">ย่าน</label>
      <select id="zone" name="zone" required>
        <option value="">— เลือกย่าน —</option>
        <option value="ลาดพร้าว">ลาดพร้าว</option>
        <option value="รัชดา-ห้วยขวาง">รัชดา-ห้วยขวาง</option>
        <option value="อ่อนนุช">อ่อนนุช</option>
        <option value="เกษตร">เกษตร</option>
        <option value="แจ้งวัฒนะ">แจ้งวัฒนะ</option>
        <option value="ศาลายา">ศาลายา</option>
        <option value="ศรีสมาน">ศรีสมาน</option>
        <option value="นครปฐม">นครปฐม</option>
        <option value="อื่นๆ">อื่นๆ</option>
      </select>
      <input id="zoneOther" type="text" placeholder="ระบุย่านของคุณ" style="display:none; margin-top:8px;" />

      <label for="propertyType">ประเภท</label>
      <select id="propertyType" name="propertyType">
        <option value="condo">คอนโด</option>
        <option value="house">บ้าน</option>
        <option value="townhouse">ทาวน์เฮ้าส์</option>
        <option value="apartment">อพาร์ตเมนต์</option>
        <option value="studio">สตูดิโอ</option>
      </select>

      <div class="row">
        <div>
          <label for="bedrooms">ห้องนอน</label>
          <input id="bedrooms" name="bedrooms" type="number" min="0" required value="1" />
        </div>
        <div>
          <label for="bathrooms">ห้องน้ำ</label>
          <input id="bathrooms" name="bathrooms" type="number" min="0" required value="1" />
        </div>
      </div>

      <label for="sizeSqm">พื้นที่ตร.ม. <span class="opt">(ไม่จำเป็น)</span></label>
      <input id="sizeSqm" name="sizeSqm" type="number" min="0" step="0.01" />

      <label for="monthlyRent">ค่าเช่า/เดือน (บาท)</label>
      <input id="monthlyRent" name="monthlyRent" type="number" min="1000" step="100" required />

      <label for="address">ที่อยู่ <span class="opt">(ไม่จำเป็น)</span></label>
      <input id="address" name="address" type="text" />

      <label for="description">รายละเอียด <span class="opt">(ไม่จำเป็น)</span></label>
      <textarea id="description" name="description"></textarea>

      <label for="photos">รูปห้อง <span class="opt">(เลือกได้หลายรูป)</span></label>
      <input id="photos" name="photos" type="file" accept="image/*" multiple />

      <button class="btn" id="submitBtn" type="submit">ส่งประกาศ</button>
    </form>
    <div id="status" class="status"></div>
  </div>

  <script>
    var LIFF_ID = ${JSON.stringify(liffId || '')};
    var SUBMIT_URL = ${JSON.stringify(submitUrl)};
    var form = document.getElementById('listingForm');
    var statusEl = document.getElementById('status');
    var submitBtn = document.getElementById('submitBtn');

    function showStatus(msg, isError) {
      statusEl.textContent = msg;
      statusEl.className = 'status ' + (isError ? 'error' : 'success');
    }
    function setLoading(on) {
      submitBtn.disabled = on;
      submitBtn.textContent = on ? 'กำลังส่ง...' : 'ส่งประกาศ';
    }

    // Initialise LIFF and read the landlord's Line userId. Renders gracefully
    // when opened outside Line (the SDK is absent or init fails): the form
    // stays usable but the hidden lineUserId stays empty, in which case the
    // server rejects the submit with a clear message.
    (function init() {
      if (!LIFF_ID || typeof liff === 'undefined') {
        showStatus('ควรเปิดฟอร์มนี้ในแอป Line ค่ะ', true);
        return;
      }
      liff.init({ liffId: LIFF_ID }).then(function () {
        // External browser without a session → redirect to Line login.
        if (!liff.isLoggedIn() && liff.isInClient() === false) {
          liff.login();
          return null;
        }
        return liff.getProfile().then(function (p) {
          document.getElementById('lineUserId').value = p.userId;
        });
      }).catch(function (err) {
        showStatus('เชื่อมต่อ Line ไม่สำเร็จ: ' + (err && err.message ? err.message : ''), true);
      });
    })();

    // Show the free-text input when "อื่นๆ" is selected, hide otherwise.
    var zoneSelect = document.getElementById('zone');
    var zoneOther  = document.getElementById('zoneOther');
    zoneSelect.addEventListener('change', function () {
      zoneOther.style.display = this.value === 'อื่นๆ' ? 'block' : 'none';
      if (this.value !== 'อื่นๆ') zoneOther.value = '';
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      setLoading(true);
      statusEl.className = 'status';
      var fd = new FormData(form);
      // When the user picks "อื่นๆ", swap in the free-text value they typed.
      if (fd.get('zone') === 'อื่นๆ') {
        var other = document.getElementById('zoneOther').value.trim();
        if (!other) {
          showStatus('กรุณาระบุย่านของคุณ', true);
          setLoading(false);
          return;
        }
        fd.set('zone', other);
      }
      // Send the LIFF access token so the server verifies our identity — the
      // hidden lineUserId field is no longer trusted on its own.
      var token = (typeof liff !== 'undefined' && liff.getAccessToken) ? liff.getAccessToken() : '';
      fetch(SUBMIT_URL, { method: 'POST', body: fd, headers: token ? { 'X-Liff-Token': token } : {} })
        .then(function (res) {
          if (!res.ok) {
            return res.json().then(function (body) {
              throw new Error(body && body.message ? body.message : 'ส่งไม่สำเร็จ (รหัส ' + res.status + ')');
            });
          }
          return res.json();
        })
        .then(function () {
          form.style.display = 'none';
          showStatus('ส่งสำเร็จค่ะ แอดมินจะตรวจสอบและอนุมัติให้ พออนุมัติแล้วห้องจะขึ้นบนเว็บทันที', false);
        })
        .catch(function (err) {
          showStatus(err && err.message ? err.message : 'ส่งไม่สำเร็จ กรุณาลองใหม่อีกครั้ง', true);
          setLoading(false);
        });
    });
  </script>
</body>
</html>`
}

// GET /listing — serve the fillable form. Content-Type text/html; charset=utf-8.
liff.get('/listing', (req, res) => {
  // Submit URL is computed from the matched mount path so the page works whether
  // it is served at /api/liff or /api/v1/liff (same-origin, no hardcoding).
  const submitUrl = `${req.baseUrl}/listing/submit`
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.send(renderListingHtml(config.LIFF_LISTING_ID, submitUrl))
})

// POST /listing/submit — receive the form, create a pending room + photos.
// Photos arrive as multipart/form-data field "photos" (max 10, images only).
liff.post('/listing/submit',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: 'ส่งประกาศบ่อยเกินไป กรุณารอสักครู่' }),
  photoUpload.array('photos', 8), asyncHandler(async (req, res) => {
  // Verify the caller's Line identity SERVER-SIDE from the LIFF access token.
  // We must NOT trust a client-sent lineUserId — anyone could spoof it to file
  // listings (or spam the admin queue) as another user.
  const token = req.headers['x-liff-token'] || req.body.accessToken
  const lineUserId = await verifyLiffToken(token)

  // Find-or-create the landlord from their Line userId (admin fills in name/
  // phone later). Mirrors the bot flow in my-listings.js.
  let landlord = await landlords.findByLineId(lineUserId)
  if (!landlord) landlord = await landlords.createFromBot(lineUserId)

  // Save the landlord's contact name + phone from the form so admin can reach
  // them outside Line (call/SMS). Updates every submission so the info stays
  // current — the landlord might use a different number next time.
  const contactName  = String(req.body.contactName || '').trim()
  const contactPhone = String(req.body.contactPhone || '').trim()
  if (contactName || contactPhone) {
    await landlords.update(landlord.id, {
      ...(contactName  ? { fullName: contactName }  : {}),
      ...(contactPhone ? { phone:    contactPhone } : {}),
    })
  }

  // Resolve the free-text zone to a numeric id.
  const zone = await findByName(req.body.zone)
  if (!zone) throw new AppError(400, 'ZONE_NOT_FOUND', 'ไม่รู้จักย่าน')

  // Validate the few fields the listing can't exist without.
  const title = String(req.body.title || '').trim()
  const monthlyRent = Number(req.body.monthlyRent)
  const bedrooms = Number(req.body.bedrooms)
  const bathrooms = Number(req.body.bathrooms)
  if (title.length < 2) {
    throw new AppError(400, 'INVALID_TITLE', 'กรุณากรอกชื่อห้องอย่างน้อย 2 ตัวอักษร')
  }
  if (!Number.isInteger(monthlyRent) || monthlyRent < 1000) {
    throw new AppError(400, 'INVALID_RENT', 'ค่าเช่าต้องเป็นจำนวนเต็มไม่ต่ำกว่า 1,000 บาท')
  }
  if (!Number.isInteger(bedrooms) || bedrooms < 0) {
    throw new AppError(400, 'INVALID_BEDROOMS', 'จำนวนห้องนอนไม่ถูกต้อง')
  }
  if (!Number.isInteger(bathrooms) || bathrooms < 0) {
    throw new AppError(400, 'INVALID_BATHROOMS', 'จำนวนห้องน้ำไม่ถูกต้อง')
  }

  const room = await rooms.createPending({
    landlordId:           landlord.id,
    zoneId:               zone.id,
    title,
    description:          req.body.description || '',
    propertyType:         req.body.propertyType || 'condo',
    bedrooms:             +req.body.bedrooms,
    bathrooms:            +req.body.bathrooms,
    sizeSqm:              +req.body.sizeSqm || 0,
    monthlyRent:          +req.body.monthlyRent,
    address:              req.body.address || null,
    createdByLineUserId:  lineUserId,
  })

  // Persist each uploaded photo under uploads/rooms/{roomId}/ and record it.
  // Same naming + URL pattern as the bot photo path in my-listings.js.
  if (req.files && req.files.length) {
    const dir = path.join(process.cwd(), 'uploads', 'rooms', String(room.id))
    await fs.mkdir(dir, { recursive: true })
    for (const file of req.files) {
      // Ext from actual bytes, not the client mimetype/filename (content-type
      // confusion → stored XSS). Skip anything that isn't a supported image.
      const ext = detectImageExt(file.buffer)
      if (!ext) continue
      const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`
      await fs.writeFile(path.join(dir, fileName), file.buffer)
      const origin = (config.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')
      const publicUrl = `${origin}/uploads/rooms/${room.id}/${fileName}`
      await roomImages.create(room.id, publicUrl, fileName)
    }
  }

  notifyAdminGroup(`🏠 [ประกาศใหม่รออนุมัติ]\n"${title}"\nเจ้าของห้อง: ${contactName || '—'} · โทร ${contactPhone || '—'}\n— อนุมัติ/ปฏิเสธได้ที่ /admin/pending-listings`)

  return res.status(201).json({ ok: true, roomId: room.id })
}))

/**
 * Verify a LIFF access token server-side and return the caller's real Line
 * userId. Checks the token is valid + issued for our LINE Login channel, then
 * resolves the profile. Throws AppError(401) on any failure. This replaces
 * trusting a client-supplied lineUserId (which was spoofable).
 */
async function verifyLiffToken(token) {
  if (!token || typeof token !== 'string') {
    throw new AppError(401, 'NO_LIFF_TOKEN', 'ไม่พบ Line token กรุณาเปิดฟอร์มนี้ใน Line')
  }
  // 1. Is the token valid, and is it for OUR channel?
  const verifyRes = await fetch(
    `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(token)}`,
  )
  if (!verifyRes.ok) {
    throw new AppError(401, 'LINE_TOKEN_INVALID', 'Line token ไม่ถูกต้องหรือหมดอายุ กรุณาเปิดฟอร์มใหม่ใน Line')
  }
  const verified = await verifyRes.json()
  if (config.LINE_LOGIN_CHANNEL_ID && verified.client_id !== config.LINE_LOGIN_CHANNEL_ID) {
    throw new AppError(401, 'LINE_TOKEN_WRONG_CHANNEL', 'Line token ไม่ใช่ของช่องนี้')
  }
  // 2. Resolve the profile → the real, unforgeable userId.
  const profRes = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!profRes.ok) {
    throw new AppError(401, 'LINE_PROFILE_FAILED', 'ดึงโปรไฟล์ Line ไม่สำเร็จ')
  }
  const profile = await profRes.json()
  if (!profile.userId) {
    throw new AppError(401, 'LINE_NO_USER', 'ไม่พบ Line user id')
  }
  return profile.userId
}
