// src/data/projects.js — Zone → project (condo) hierarchy for the LIFF form.
//
// ⚠ MIRROR OF client/src/data/projects.js. The two live in separate git repos,
// so they cannot import each other; edit BOTH when a property is added. The
// admin room form is the reference — this file exists so the LIFF form offers
// the identical list rather than a second, quietly different one.
//
// This deliberately replaces an earlier version that derived the list from
// existing rooms: that only ever showed buildings we already had a room in, so
// the first room of a new project could never be filed under it.

export const ZONE_PROJECTS = {
  'ลาดพร้าว': [
    'Atmoz Ladprao 71',
    'Atmoz Palacio Ladprao-Wanghin',
    'Atmoz Ladprao 15',
  ],
  'รัชดา-ห้วยขวาง': [
    'Atmoz Ratchada-Huaikwang',
  ],
  'ศรีสมาน': [
    'Atmoz Portrait Srisaman',
  ],
  'อ่อนนุช': [
    'Atmoz Oasis Onnut',
  ],
  'เกษตร': [
    'Modiz Vault Kaset – Sripatum',
    'Kave Seed Kaset',
  ],
  'แจ้งวัฒนะ': [
    'Atmoz Chaengwattana',
  ],
  'ศาลายา': [
    'Kave Mutant Salaya',
    'Kave Pop Salaya',
  ],
  'นครปฐม': [
    // Thai spelling is canonical — the English one drifted into the data and
    // split this building across two dashboard rows.
    'Kave Genesis นครปฐม',
  ],
}

/** Zone names in display order — drives the LIFF zone dropdown. */
export const ZONE_NAMES = Object.keys(ZONE_PROJECTS)

/**
 * Room types, mirroring the admin form's list so a landlord and an admin
 * describe the same room the same way.
 */
export const ROOM_TYPES = [
  'STUDIO',
  '1 BEDROOM',
  '1 BEDROOM EXCLUSIVE',
  '1 BEDROOM EXTRA',
  '1 BEDROOM PLUS',
]
