// scripts/profile-import-sheet.js — describe an inventory spreadsheet WITHOUT
// revealing its contents.
//
//   node scripts/profile-import-sheet.js "/path/to/stock.xlsx"
//
// Written so the sheet can be discussed with someone who must not see the data.
// Columns are split into two groups:
//
//   • SAFE     — low-cardinality categories (Status, Type, ทิศ, วิว …). Distinct
//                values and their counts are printed, because that is what a
//                field mapping has to be built against.
//   • PRIVATE  — names, phone numbers, staff, addresses, door codes. Only the
//                fill rate is printed. Never a value, never a sample.
//
// Anything not on either list is treated as PRIVATE. The default has to be
// "don't print it" — a column nobody classified is exactly the one that turns
// out to hold a phone number.
//
// Free-text columns are summarised by length only, since even one sample line
// can carry a name or a number.

import path from 'node:path'
import ExcelJS from 'exceljs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/profile-import-sheet.js "/path/to/stock.xlsx"')
  process.exit(1)
}

// Categorical columns: safe to show distinct values, because the values ARE the
// vocabulary we need to map ("Available"/"ว่าง"/"จองแล้ว" → our status enum).
const SAFE = new Set([
  'ประเภทลูกค้า', 'Project', 'รหัสโครงการ', 'อาคาร', 'ชั้น', 'Size', 'Type',
  'ทิศ', 'วิว', 'ค่าเช่าต่อเดือน', 'Status', 'Source', 'มีรูป', 'ช่องทางการฝาก',
  'Check', 'Web Ref',
])

// Never printed, at any cardinality.
const PRIVATE = new Set([
  'Name', 'Tel', 'Sales', 'Update By', 'บ้านเลขที่', 'รหัสเข้าห้อง',
  'Remark', 'ยูนิต', 'รหัสโครงการ-ยูนิต', 'No.', 'Date',
  'วันที่ update ข้อมูล', 'วันที่หมดสัญญาเช่า',
])

// Above this, a "category" is really free text — print shape, not values.
const MAX_DISTINCT = 40

const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(file)

console.log(`\nFile: ${path.basename(file)}`)
console.log(`Sheets: ${wb.worksheets.map((w) => `${w.name} (${w.rowCount} rows)`).join(', ')}\n`)

for (const ws of wb.worksheets) {
  const headerRow = ws.getRow(1)
  const headers = []
  headerRow.eachCell((cell, col) => { headers[col] = String(cell.value ?? '').trim() })

  const cols = new Map()   // header → { filled, total, values:Map, maxLen }
  for (const h of headers) if (h) cols.set(h, { filled: 0, total: 0, values: new Map(), maxLen: 0 })

  ws.eachRow((row, n) => {
    if (n === 1) return
    headers.forEach((h, col) => {
      if (!h) return
      const c = cols.get(h)
      const raw = row.getCell(col).value
      const v = raw == null ? '' : String(typeof raw === 'object' && raw.text ? raw.text : raw).trim()
      c.total++
      if (v) { c.filled++; c.maxLen = Math.max(c.maxLen, v.length) }
      if (v) c.values.set(v, (c.values.get(v) || 0) + 1)
    })
  })

  console.log(`── ${ws.name} ─────────────────────────────────`)
  for (const [h, c] of cols) {
    const fill = c.total ? Math.round((c.filled / c.total) * 100) : 0
    const distinct = c.values.size

    if (PRIVATE.has(h) || !SAFE.has(h)) {
      const why = PRIVATE.has(h) ? 'private' : 'unclassified → treated as private'
      console.log(`  ${h.padEnd(24)} filled ${String(fill).padStart(3)}%  distinct ${String(distinct).padStart(4)}  maxlen ${String(c.maxLen).padStart(4)}  [${why}]`)
      continue
    }

    if (distinct > MAX_DISTINCT) {
      console.log(`  ${h.padEnd(24)} filled ${String(fill).padStart(3)}%  distinct ${String(distinct).padStart(4)}  maxlen ${String(c.maxLen).padStart(4)}  [too many distinct — values withheld]`)
      continue
    }

    const top = [...c.values.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}×${n}`)
    console.log(`  ${h.padEnd(24)} filled ${String(fill).padStart(3)}%  distinct ${String(distinct).padStart(4)}`)
    console.log(`      ${top.join('  |  ')}`)
  }
  console.log('')
}

console.log('Nothing above identifies a person: names, phones, units, addresses and')
console.log('door codes are reported as counts only. Safe to paste into a chat.\n')
