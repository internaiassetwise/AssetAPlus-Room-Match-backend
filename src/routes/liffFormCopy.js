// src/routes/liffFormCopy.js — every visible string in the LIFF listing form,
// in both languages.
//
// Kept out of liff.js because that file is one large HTML template literal;
// burying two copies of forty strings inside it makes both the markup and the
// translations hard to read, and a missed string is invisible in the diff.
//
// The whole object is serialised into the page, so the toggle switches language
// with no round trip. Keys are shared by the markup (data-i18n / data-i18n-ph)
// and the inline script, so a label and the validation message about that same
// field can never drift into different languages.
//
// TH and EN must stay key-for-key identical — assertFormCopyParity() below is
// called at import time so a missing key fails at boot rather than rendering
// "undefined" to a landlord.

const th = {
  // Page chrome
  title: 'ลงประกาศห้องของคุณ',
  sub: 'กรอกข้อมูลแล้วกดส่ง แอดมินจะตรวจสอบและอนุมัติให้ค่ะ',
  submit: 'ส่งประกาศ',
  submitting: 'กำลังส่ง...',
  optional: '(ไม่จำเป็น)',
  commaSeparated: '(คั่นด้วยจุลภาค)',
  contactPersonSummary: 'ลงทะเบียนแทนคนอื่น? (เช่น ลงให้พ่อแม่)',

  // Labels
  contactName: 'ชื่อเจ้าของห้อง',
  contactPhone: 'เบอร์โทร',
  contactPersonName: 'ชื่อผู้ติดต่อ',
  contactPersonPhone: 'เบอร์ผู้ติดต่อ',
  contactPersonRelation: 'ความสัมพันธ์กับเจ้าของห้อง',
  zone: 'โซน / ทำเล',
  projectName: 'ชื่อโครงการ',
  roomCode: 'รหัสห้อง / เลขห้อง',
  roomType: 'ประเภทห้อง',
  building: 'ตึก',
  floor: 'ชั้น',
  viewType: 'วิว',
  bedrooms: 'ห้องนอน',
  bathrooms: 'ห้องน้ำ',
  sizeSqm: 'พื้นที่ตร.ม.',
  monthlyRent: 'ค่าเช่า/เดือน (บาท)',
  description: 'รายละเอียด',
  amenities: 'สิ่งอำนวยความสะดวก',
  availableFrom: 'วันที่ว่าง',
  address: 'ที่อยู่',
  photos: 'รูปภาพห้อง',

  // Placeholders
  phContactName: 'เช่น คุณสมชัย',
  phContactPhone: 'เช่น 081-234-5678',
  phContactPersonName: 'ชื่อคนที่ให้ติดต่อกลับ',
  phContactPersonPhone: 'เบอร์ที่โทรติดจริง',
  phRelationOther: 'ระบุความสัมพันธ์',
  phZoneOther: 'ระบุโซน / ทำเลของคุณ',
  phProjectOther: 'พิมพ์ชื่อโครงการ',
  phRoomCode: 'เช่น A0123',
  phBuilding: 'เช่น A',
  phFloor: 'เช่น 12',
  phViewType: 'เช่น วิวสระว่ายน้ำ',
  phDescription: 'จุดเด่น ทำเล สภาพห้อง ฯลฯ',

  // Select placeholders
  optSelect: '— เลือก —',
  optSelectZone: '— เลือกโซน / ทำเล —',
  optSelectProject: '— เลือกโครงการ —',
  optTypeProject: '— พิมพ์ชื่อโครงการ —',
  optPickZoneFirst: '— เลือกย่านก่อน —',
  optSelectRoomType: '— เลือกประเภทห้อง —',
  optOther: 'อื่นๆ',
  optOtherSpecify: 'อื่นๆ — พิมพ์ชื่อเอง…',
  relationOtherSuffix: '(ระบุ)',
  'rel_บิดา/มารดา': 'บิดา/มารดา',
  'rel_คู่สมรส': 'คู่สมรส',
  'rel_บุตร': 'บุตร',
  'rel_พี่/น้องร่วมสายเลือด': 'พี่/น้องร่วมสายเลือด',
  'rel_อื่นๆ': 'อื่นๆ (ระบุ)',

  // Runtime messages
  msgNeedZone: 'กรุณาระบุโซน / ทำเลของคุณ',
  msgNeedProject: 'กรุณาเลือกหรือพิมพ์ชื่อโครงการ',
  msgOpenInLine: 'ควรเปิดฟอร์มนี้ในแอป Line ค่ะ',
  msgLineFailed: 'เชื่อมต่อ Line ไม่สำเร็จ: ',
  msgSuccess: 'ส่งสำเร็จค่ะ แอดมินจะตรวจสอบและอนุมัติให้ พออนุมัติแล้วห้องจะขึ้นบนเว็บทันที',
  msgFailedCode: 'ส่งไม่สำเร็จ (รหัส ',
  msgFailed: 'ส่งไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
  photoMax: 'แนบรูปได้สูงสุด ',
  photoPicked: 'เลือก ',
  photoUnit: ' รูป',
  photoOver: ' รูป — เกินกำหนด ',
  photoReselect: ' รูป กรุณาเลือกใหม่',
  photoSelectedCount: ' รูป (เลือกไว้ ',
  photoCloseParen: ' รูป)',
  photosMaxHint: 'สูงสุด',
  photosUnitHint: 'รูป',
  // Bangkok districts. Values stay Thai everywhere — this is the label only.
  'zone_ลาดพร้าว': 'ลาดพร้าว',
  'zone_รัชดา-ห้วยขวาง': 'รัชดา-ห้วยขวาง',
  'zone_ศรีสมาน': 'ศรีสมาน',
  'zone_อ่อนนุช': 'อ่อนนุช',
  'zone_เกษตร': 'เกษตร',
  'zone_แจ้งวัฒนะ': 'แจ้งวัฒนะ',
  'zone_ศาลายา': 'ศาลายา',
  'zone_นครปฐม': 'นครปฐม',
}

const en = {
  title: 'List your room',
  sub: 'Fill this in and submit. An admin will review and approve it.',
  submit: 'Submit listing',
  submitting: 'Sending…',
  optional: '(optional)',
  commaSeparated: '(comma separated)',
  contactPersonSummary: 'Listing on someone else’s behalf? (e.g. for a parent)',

  contactName: 'Room owner’s name',
  contactPhone: 'Phone number',
  contactPersonName: 'Contact person’s name',
  contactPersonPhone: 'Contact person’s phone',
  contactPersonRelation: 'Relationship to the owner',
  zone: 'Area',
  projectName: 'Project name',
  roomCode: 'Unit number',
  roomType: 'Room type',
  building: 'Building',
  floor: 'Floor',
  viewType: 'View',
  bedrooms: 'Bedrooms',
  bathrooms: 'Bathrooms',
  sizeSqm: 'Size (sqm)',
  monthlyRent: 'Rent per month (THB)',
  description: 'Details',
  amenities: 'Amenities',
  availableFrom: 'Available from',
  address: 'Address',
  photos: 'Room photos',

  phContactName: 'e.g. Somchai',
  phContactPhone: 'e.g. 081-234-5678',
  phContactPersonName: 'Who should we call?',
  phContactPersonPhone: 'A number that actually reaches them',
  phRelationOther: 'Describe the relationship',
  phZoneOther: 'Enter your area',
  phProjectOther: 'Type the project name',
  phRoomCode: 'e.g. A0123',
  phBuilding: 'e.g. A',
  phFloor: 'e.g. 12',
  phViewType: 'e.g. pool view',
  phDescription: 'Highlights, location, condition…',

  optSelect: '— Select —',
  optSelectZone: '— Select an area —',
  optSelectProject: '— Select a project —',
  optTypeProject: '— Type the project name —',
  optPickZoneFirst: '— Pick an area first —',
  optSelectRoomType: '— Select a room type —',
  optOther: 'Other',
  optOtherSpecify: 'Other — type it in…',
  relationOtherSuffix: '(specify)',
  'rel_บิดา/มารดา': 'Parent',
  'rel_คู่สมรส': 'Spouse',
  'rel_บุตร': 'Child',
  'rel_พี่/น้องร่วมสายเลือด': 'Sibling',
  'rel_อื่นๆ': 'Other (specify)',

  msgNeedZone: 'Please enter your area',
  msgNeedProject: 'Please select or type a project name',
  msgOpenInLine: 'Please open this form inside the LINE app',
  msgLineFailed: 'Could not connect to LINE: ',
  msgSuccess: 'Sent. An admin will review it — once approved your room appears on the site straight away.',
  msgFailedCode: 'Could not send (code ',
  msgFailed: 'Could not send. Please try again.',
  photoMax: 'You can attach at most ',
  photoPicked: 'Selected ',
  photoUnit: ' photos',
  photoOver: ' photos — over the limit of ',
  photoReselect: ' photos. Please choose fewer.',
  photoSelectedCount: ' photos (you selected ',
  photoCloseParen: ' photos)',
  photosMaxHint: 'max',
  photosUnitHint: 'photos',
  'zone_ลาดพร้าว': 'Lat Phrao',
  'zone_รัชดา-ห้วยขวาง': 'Ratchada-Huai Khwang',
  'zone_ศรีสมาน': 'Si Saman',
  'zone_อ่อนนุช': 'On Nut',
  'zone_เกษตร': 'Kaset',
  'zone_แจ้งวัฒนะ': 'Chaeng Watthana',
  'zone_ศาลายา': 'Salaya',
  'zone_นครปฐม': 'Nakhon Pathom',
}

/** Fails at import time rather than rendering `undefined` to a landlord. */
function assertFormCopyParity() {
  const a = Object.keys(th).sort()
  const b = Object.keys(en).sort()
  const missing = [
    ...a.filter((k) => !(k in en)).map((k) => `en is missing "${k}"`),
    ...b.filter((k) => !(k in th)).map((k) => `th is missing "${k}"`),
  ]
  if (missing.length) throw new Error(`liffFormCopy parity: ${missing.join(', ')}`)
}
assertFormCopyParity()

export const FORM_COPY = { th, en }
export const FORM_COPY_KEYS = Object.keys(th)
