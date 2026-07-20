// src/routes/leads.js — Anonymous tenant lead capture.
//
// Public endpoint — no auth. Throttled by IP (5/min). Stores a row in
// `tenant_leads` that admin staff can act on, AND pushes a heads-up to the
// admin Line group (when LINE_ADMIN_GROUP_ID is set) so someone can react
// fast. Admin-only GET /tenant.xlsx exports the full table for tracing.

import { Router } from 'express'
import { z } from 'zod'
import ExcelJS from 'exceljs'
import * as repo from '../db/repositories/leads.repo.js'
import { notifyAdminGroup } from '../linebot/adminAlert.service.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { validate }     from '../middleware/validate.js'
import { rateLimit }    from '../middleware/rateLimit.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { logger } from '../logger.js'

export const leads = Router()

const tenantBody = z.object({
  zone:          z.string().trim().max(40).optional().or(z.literal('')),
  monthlyBudget: z.coerce.number().int().nonnegative().optional(),
  propertyType:  z.string().trim().max(40).optional().or(z.literal('')),
  moveIn:        z.string().trim().max(40).optional().or(z.literal('')),
  fullName:      z.string().trim().min(1, 'กรุณาระบุชื่อ').max(120),
  phone:         z.string().trim().min(8, 'กรุณาระบุเบอร์โทร').max(40),
})

leads.post('/tenant',
  rateLimit({ windowMs: 60 * 1000, max: 5, message: 'ส่งบ่อยเกินไป กรุณารอสักครู่' }),
  validate({ body: tenantBody }),
  asyncHandler(async (req, res) => {
    const id = await repo.createTenantLead({
      ...req.body,
      source: req.headers.referer || 'landing',
    })

    // Push a heads-up to the admin Line group (best-effort — never blocks
    // the response). notifyAdminGroup swallows errors internally, so a Line
    // outage won't surface to the tenant.
    notifyAdminGroup(formatLeadAlert({ ...req.body, id }))

    res.status(201).json({ ok: true, id })
  }),
)

/**
 * GET /tenant.xlsx — admin-only Excel export of every tenant lead.
 *
 * Streams a .xlsx generated on demand from the tenant_leads table. We
 * regenerate on each request rather than appending to a persisted file
 * because Railway's filesystem is ephemeral (files vanish on redeploy) —
 * the DB is the source of truth and a fresh export always reflects the
 * latest submissions.
 */
leads.get('/tenant.xlsx', requireAdmin, asyncHandler(async (req, res) => {
  const rows = await repo.listAll()

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Room Match'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet('Tenant Leads', {
    properties: { defaultColWidth: 18 },
  })

  sheet.columns = [
    { header: 'ID',           key: 'id',           width: 6 },
    { header: 'วันที่ส่ง',     key: 'created_at',  width: 20 },
    { header: 'ชื่อ',          key: 'full_name',   width: 20 },
    { header: 'เบอร์โทร',      key: 'phone',       width: 16 },
    { header: 'โซน/ทำเล',     key: 'zone',        width: 16 },
    { header: 'งบประมาณ (฿)', key: 'monthly_budget', width: 14 },
    { header: 'ประเภทห้อง',   key: 'property_type', width: 14 },
    { header: 'ย้ายเข้า',      key: 'move_in',     width: 16 },
    { header: 'สถานะ',        key: 'status',      width: 12 },
    { header: 'แหล่งที่มา',    key: 'source_page', width: 24 },
  ]

  // Style the header row — bold + filled so it's easy to spot when scrolling.
  sheet.getRow(1).font = { bold: true }
  sheet.getRow(1).fill = {
    type: 'pattern', pattern: 'solid',
    fgColor: { argb: 'FF0F1F47' }, // navy-700 to match the site
  }
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'left' }
  sheet.views = [{ state: 'frozen', ySplit: 1 }] // keep header visible while scrolling

  for (const r of rows) {
    sheet.addRow({
      id: r.id,
      created_at: r.created_at,
      full_name: r.full_name,
      phone: r.phone,
      zone: r.zone,
      monthly_budget: r.monthly_budget,
      property_type: r.property_type,
      move_in: r.move_in,
      status: r.status,
      source_page: r.source_page,
    })
  }

  // Format the date column + enable Excel's auto-filter so admins can sort/
  // filter by zone, status, etc. without leaving Excel.
  sheet.getColumn('created_at').numFmt = 'yyyy-mm-dd hh:mm'
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: rows.length + 1, column: sheet.columns.length },
  }

  const today = new Date().toISOString().slice(0, 10)
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="tenant-leads-${today}.xlsx"`,
  )
  // X-Robots-Tag so a cached copy sitting in a CDN isn't indexed.
  res.setHeader('X-Robots-Tag', 'noindex')

  await workbook.xlsx.write(res)
  res.end()
}))

/**
 * Build the short Thai alert pushed to the admin Line group on each new
 * tenant lead. Keeps the message under Line's 2000-char limit and includes
 * only what an on-duty admin needs to decide whether to call back now or
 * queue for later.
 */
function formatLeadAlert({ id, fullName, phone, zone, monthlyBudget, propertyType, moveIn }) {
  const lines = [
    '🔔 [Lead ใหม่จากเว็บ]',
    `ชื่อ: ${fullName || '—'}`,
    `เบอร์: ${phone || '—'}`,
  ]
  if (zone)          lines.push(`โซน: ${zone}`)
  if (monthlyBudget) lines.push(`งบ: ฿${Number(monthlyBudget).toLocaleString('th-TH')}`)
  if (propertyType)  lines.push(`ประเภท: ${propertyType}`)
  if (moveIn)        lines.push(`ย้ายเข้า: ${moveIn}`)
  lines.push(`\n(ID #${id} · ดาวน์โหลด Excel ได้ที่หน้าแอดมิน)`)
  return lines.join('\n')
}
