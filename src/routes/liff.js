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
import { resizeForWeb } from '../services/imageResize.service.js'
import { config } from '../config.js'
import * as landlords   from '../db/repositories/landlords.repo.js'
import { findByName }   from '../db/repositories/zones.repo.js'
import { query }        from '../db/pool.js'
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
function renderListingHtml(liffId, submitUrl, ZONE_PROJECTS = {}) {
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
      width: 100%; padding: 10px 12px; font-size: 16px;
      border: 1px solid #D1D5DB; border-radius: 10px; background: #fff;
    }
    /* 16px above is deliberate: iOS Safari zooms the page in on focus for
       anything smaller, which throws this form off-screen mid-entry. */
    .contact-person {
      margin-top: 14px; padding: 10px 12px;
      border: 1px dashed #D1D5DB; border-radius: 10px; background: #FAFAFA;
    }
    .contact-person > summary {
      font-size: 13px; font-weight: 600; color: #1F4068;
      cursor: pointer; list-style: none; min-height: 24px;
    }
    .contact-person > summary::-webkit-details-marker { display: none; }
    .contact-person > summary::before { content: '+ '; font-weight: 700; }
    .contact-person[open] > summary::before { content: '− '; }
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

      <!-- Contact person. Collapsed by default: most owners are their own
           contact, and three extra fields on a phone form is where people give
           up. <details> keeps it one tap away without any JS. -->
      <details class="contact-person">
        <summary>ลงทะเบียนแทนคนอื่น? (เช่น ลงให้พ่อแม่)</summary>
        <label for="contactPersonName">ชื่อผู้ติดต่อ</label>
        <input id="contactPersonName" name="contactPersonName" type="text" placeholder="ชื่อคนที่ให้ติดต่อกลับ" />

        <label for="contactPersonPhone">เบอร์ผู้ติดต่อ</label>
        <input id="contactPersonPhone" name="contactPersonPhone" type="tel" placeholder="เบอร์ที่โทรติดจริง" />

        <label for="contactPersonRelation">ความสัมพันธ์กับเจ้าของห้อง</label>
        <select id="contactPersonRelation" name="contactPersonRelation">
          <option value="">— เลือก —</option>
          <option value="บิดา/มารดา">บิดา/มารดา</option>
          <option value="คู่สมรส">คู่สมรส</option>
          <option value="บุตร">บุตร</option>
          <option value="พี่/น้องร่วมสายเลือด">พี่/น้องร่วมสายเลือด</option>
          <option value="อื่นๆ">อื่นๆ (ระบุ)</option>
        </select>
        <input id="contactPersonRelationOther" name="contactPersonRelationOther" type="text"
               placeholder="ระบุความสัมพันธ์" style="display:none; margin-top:8px;" />
      </details>

      <label for="zone">ย่าน</label>
      <select id="zone" name="zone" required>
        <option value="">— เลือกย่าน —</option>
        <option value="ลาดพร้าว">ลาดพร้าว</option>
        <option value="รัชดา-ห้วยขวาง">รัชดา-ห้วยขวาง</option>
        <option value="ศรีสมาน">ศรีสมาน</option>
        <option value="อ่อนนุช">อ่อนนุช</option>
        <option value="เกษตร">เกษตร</option>
        <option value="แจ้งวัฒนะ">แจ้งวัฒนะ</option>
        <option value="ศาลายา">ศาลายา</option>
        <option value="นครปฐม">นครปฐม</option>
        <option value="อื่นๆ">อื่นๆ</option>
      </select>
      <input id="zoneOther" type="text" placeholder="ระบุย่านของคุณ" style="display:none; margin-top:8px;" />

      <label for="projectName">ชื่อโครงการ <span class="opt">*</span></label>
      <select id="projectName" name="projectName" required>
        <option value="">— เลือกย่านก่อน —</option>
      </select>
      <input id="projectNameOther" name="projectNameOther" type="text"
             placeholder="พิมพ์ชื่อโครงการ" style="display:none; margin-top:8px;" />

      <label for="roomCode">รหัสห้อง / เลขห้อง <span class="opt">*</span></label>
      <input id="roomCode" name="roomCode" type="text" required placeholder="เช่น A0123" />

      <label for="propertyType">ประเภทที่อยู่อาศัย</label>
      <select id="propertyType" name="propertyType">
        <option value="condo">คอนโด</option>
        <option value="house">บ้าน</option>
        <option value="townhouse">ทาวน์เฮ้าส์</option>
        <option value="apartment">อพาร์ตเมนต์</option>
        <option value="studio">สตูดิโอ</option>
      </select>

      <label for="roomType">ประเภทห้อง</label>
      <select id="roomType" name="roomType">
        <option value="">— เลือกประเภทห้อง —</option>
        <option value="STUDIO">Studio</option>
        <option value="1 BEDROOM">1 Bedroom</option>
        <option value="2 BEDROOM">2 Bedroom</option>
        <option value="DUPLEX">Duplex</option>
        <option value="PENTHOUSE">Penthouse</option>
      </select>

      <div class="row">
        <div>
          <label for="building">ตึก</label>
          <input id="building" name="building" type="text" placeholder="เช่น A" />
        </div>
        <div>
          <label for="floor">ชั้น</label>
          <input id="floor" name="floor" type="number" min="-10" max="200" placeholder="เช่น 12" />
        </div>
      </div>

      <label for="viewType">วิว</label>
      <input id="viewType" name="viewType" type="text" placeholder="เช่น วิวสระว่ายน้ำ" />

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

      <label for="description">รายละเอียด</label>
      <textarea id="description" name="description" placeholder="จุดเด่น ทำเล สภาพห้อง ฯลฯ"></textarea>

      <label for="amenities">สิ่งอำนวยความสะดวก <span class="opt">(คั่นด้วยจุลภาค)</span></label>
      <input id="amenities" name="amenities" type="text" placeholder="wifi, pool, gym" />

      <label for="availableFrom">วันที่ว่าง</label>
      <input id="availableFrom" name="availableFrom" type="date" />

      <label for="address">ที่อยู่ <span class="opt">(ไม่จำเป็น)</span></label>
      <input id="address" name="address" type="text" />

      <label for="photos">รูปภาพห้อง <span class="opt">(เลือกได้หลายรูป)</span></label>
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

    // Zone -> project, the same cascade the admin form uses. Mirrored here
    // rather than fetched so the form still works on a flaky mobile connection
    // inside LINE; the list is short and changes rarely.
    var ZONE_PROJECTS = ${JSON.stringify(ZONE_PROJECTS)};

    function toggleOther(sel, other, trigger) {
      var on = sel.value === trigger;
      other.style.display = on ? 'block' : 'none';
      if (!on) other.value = '';
      other.required = on;
    }

    var zoneSelect    = document.getElementById('zone');
    var zoneOther     = document.getElementById('zoneOther');
    var projectSelect = document.getElementById('projectName');
    var projectOther  = document.getElementById('projectNameOther');
    var relSelect     = document.getElementById('contactPersonRelation');
    var relOther      = document.getElementById('contactPersonRelationOther');

    function fillProjects(zoneName) {
      var list = ZONE_PROJECTS[zoneName] || [];
      projectSelect.innerHTML = '';
      var first = document.createElement('option');
      first.value = '';
      first.textContent = list.length ? '— เลือกโครงการ —' : '— พิมพ์ชื่อโครงการ —';
      projectSelect.appendChild(first);
      list.forEach(function (name) {
        var o = document.createElement('option');
        o.value = name; o.textContent = name;
        projectSelect.appendChild(o);
      });
      // Always offer a way out of the list: a zone we don't have on file, or a
      // brand-new building, must not be a dead end.
      var other = document.createElement('option');
      other.value = 'อื่นๆ'; other.textContent = 'อื่นๆ — พิมพ์ชื่อเอง…';
      projectSelect.appendChild(other);
      if (!list.length) { projectSelect.value = 'อื่นๆ'; }
      toggleOther(projectSelect, projectOther, 'อื่นๆ');
    }

    zoneSelect.addEventListener('change', function () {
      toggleOther(zoneSelect, zoneOther, 'อื่นๆ');
      fillProjects(this.value);
    });
    projectSelect.addEventListener('change', function () {
      toggleOther(projectSelect, projectOther, 'อื่นๆ');
    });
    if (relSelect) {
      relSelect.addEventListener('change', function () {
        toggleOther(relSelect, relOther, 'อื่นๆ');
      });
    }

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
      // Same swap for project and relationship: the select holds a sentinel,
      // the real value is in the text box beside it.
      if (fd.get('projectName') === 'อื่นๆ' || !fd.get('projectName')) {
        var proj = document.getElementById('projectNameOther').value.trim();
        if (!proj) {
          showStatus('กรุณาเลือกหรือพิมพ์ชื่อโครงการ', true);
          setLoading(false);
          return;
        }
        fd.set('projectName', proj);
      }
      if (fd.get('contactPersonRelation') === 'อื่นๆ') {
        fd.set('contactPersonRelation',
               document.getElementById('contactPersonRelationOther').value.trim() || 'อื่นๆ');
      }
      // The project name IS the listing title — one source, so the two can't
      // drift the way the legacy free-text title did.
      fd.set('title', fd.get('projectName'));
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
/**
 * Zone → the projects we already have rooms in.
 *
 * Read from the data rather than duplicating the client's curated list: this
 * page lives in the server repo and that list lives in the client repo, so a
 * copy here would drift the first time either side is edited. Deriving it also
 * means a new building appears in the dropdown as soon as one room uses it.
 *
 * Best-effort — the form still works with an empty map, because the project
 * field always offers "พิมพ์ชื่อเอง".
 */
async function zoneProjects() {
  try {
    const { rows } = await query(
      `SELECT z.name_th AS zone, r.project_name AS project
         FROM rooms r JOIN zones z ON z.id = r.zone_id
        WHERE NULLIF(TRIM(r.project_name), '') IS NOT NULL
        GROUP BY z.name_th, r.project_name
        ORDER BY z.name_th, r.project_name`,
    )
    const out = {}
    for (const r of rows) (out[r.zone] ??= []).push(r.project)
    return out
  } catch (err) {
    logger.warn({ err: err.message }, 'liff: could not load zone/project list')
    return {}
  }
}

liff.get('/listing', asyncHandler(async (req, res) => {
  // Submit URL is computed from the matched mount path so the page works whether
  // it is served at /api/liff or /api/v1/liff (same-origin, no hardcoding).
  const submitUrl = `${req.baseUrl}/listing/submit`
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.send(renderListingHtml(config.LIFF_LISTING_ID, submitUrl, await zoneProjects()))
}))

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
  // Whoever should actually be called, when that is not the owner. Relation is
  // validated against the same list the admin form offers; anything else is
  // dropped rather than trusted, since this arrives from a public form.
  const RELATIONS = ['child', 'spouse', 'relative', 'agent', 'other']
  const cpName     = String(req.body.contactPersonName  || '').trim().slice(0, 160)
  const cpPhone    = String(req.body.contactPersonPhone || '').trim().slice(0, 40)
  const cpRelation = RELATIONS.includes(String(req.body.contactPersonRelation || '').trim())
    ? String(req.body.contactPersonRelation).trim() : null
  if (contactName || contactPhone || cpName || cpPhone) {
    await landlords.update(landlord.id, {
      ...(contactName  ? { fullName: contactName }  : {}),
      ...(contactPhone ? { phone:    contactPhone } : {}),
      ...(cpName     ? { contactName:     cpName }     : {}),
      ...(cpPhone    ? { contactPhone:    cpPhone }    : {}),
      ...(cpRelation ? { contactRelation: cpRelation } : {}),
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

  // Amenities arrive as one comma-separated string, same as the admin form.
  const amenities = String(req.body.amenities || '')
    .split(',').map((a) => a.trim()).filter(Boolean).slice(0, 50)
  const floor = req.body.floor === '' || req.body.floor == null ? null : Number(req.body.floor)

  const room = await rooms.createPending({
    landlordId:           landlord.id,
    zoneId:               zone.id,
    title,
    description:          req.body.description || '',
    propertyType:         req.body.propertyType || 'condo',
    roomType:             req.body.roomType || null,
    projectName:          req.body.projectName || null,
    roomCode:             req.body.roomCode || null,
    building:             req.body.building || null,
    floor:                Number.isFinite(floor) ? floor : null,
    viewType:             req.body.viewType || null,
    bedrooms:             +req.body.bedrooms,
    bathrooms:            +req.body.bathrooms,
    sizeSqm:              +req.body.sizeSqm || 0,
    monthlyRent:          +req.body.monthlyRent,
    availableFrom:        req.body.availableFrom || null,
    amenities,
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
      const optimized = await resizeForWeb(file.buffer)
      const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`
      await fs.writeFile(path.join(dir, fileName), optimized)
      const origin = (config.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')
      const publicUrl = `${origin}/uploads/rooms/${room.id}/${fileName}`
      await roomImages.create(room.id, publicUrl, fileName)
    }
  }

  notifyAdminGroup(`🏠 [ประกาศใหม่รออนุมัติ]\n"${title}"\nเจ้าของห้อง: ${contactName || '—'} · โทร ${contactPhone || '—'}${cpName || cpPhone ? `\nติดต่อผ่าน: ${cpName || '—'} · โทร ${cpPhone || '—'}` : ''}\n— อนุมัติ/ปฏิเสธได้ที่ /admin/pending-listings`)

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
