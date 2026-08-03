// src/routes/adminStats.js — numbers for the admin dashboard (/admin).
//
//   GET /api/admin/stats → { totals, byProject, byZone, topInterest }
//
// One request, because the dashboard is the first screen after login and four
// round-trips on a phone is the difference between "instant" and "loading".

import { Router } from 'express'
import { query } from '../db/pool.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import * as roomInterest from '../db/repositories/roomInterest.repo.js'

export const adminStats = Router()

// Project names are admin-typed free text, so the same building arrives spelled
// several ways ("Kave Genesis นครปฐม" vs "Kave Genesis Nakorn Pathom") and would
// be counted as two. Fold the known variants onto one canonical name — the one
// the user picked — rather than silently reporting a split.
//
// This is a display-level fix. The underlying rows still hold what admin typed;
// making the column an enum or a foreign key is the real fix and a bigger change.
const PROJECT_ALIASES = {
  'kave genesis nakorn pathom': 'Kave Genesis นครปฐม',
  'kave genesis นครปฐม':        'Kave Genesis นครปฐม',
}

function canonicalProject(name) {
  const raw = String(name ?? '').trim()
  if (!raw) return null
  return PROJECT_ALIASES[raw.toLowerCase()] ?? raw
}

adminStats.get('/', requireAdmin, asyncHandler(async (_req, res) => {
  const [totals, rooms, zones, topInterest] = await Promise.all([
    query(`
      SELECT
        (SELECT COUNT(*) FROM rooms)::int                                  AS rooms_total,
        (SELECT COUNT(*) FROM rooms WHERE status = 'available')::int       AS rooms_available,
        (SELECT COUNT(*) FROM rooms WHERE status = 'reserved')::int        AS rooms_reserved,
        (SELECT COUNT(*) FROM rooms WHERE status = 'pending')::int         AS rooms_pending,
        (SELECT COUNT(*) FROM tenants)::int                                AS tenants,
        (SELECT COUNT(*) FROM landlords)::int                              AS landlords,
        (SELECT COUNT(*) FROM admin_queue WHERE status = 'open')::int      AS inbox_open,
        (SELECT COUNT(*) FROM viewings
          WHERE scheduled_for BETWEEN NOW() AND NOW() + INTERVAL '7 days'
            AND status <> 'cancelled')::int                                AS viewings_week
    `),
    // Grouped in JS, not SQL: the alias folding above has to happen before the
    // GROUP BY, and encoding that table in SQL would mean shipping a migration
    // every time a project is renamed.
    query(`
      SELECT r.project_name, r.status, r.monthly_rent, r.view_count
        FROM rooms r
    `),
    query(`
      SELECT COALESCE(z.name_th, '(ไม่ระบุทำเล)') AS zone,
             COUNT(*)::int                                                   AS rooms,
             COUNT(*) FILTER (WHERE r.status = 'available')::int             AS available,
             ROUND(AVG(r.monthly_rent))::int                                 AS avg_rent,
             COALESCE(SUM(r.view_count), 0)::int                             AS views
        FROM rooms r
        LEFT JOIN zones z ON z.id = r.zone_id
       GROUP BY z.name_th
       ORDER BY rooms DESC, zone ASC
    `),
    roomInterest.countsByRoom({ limit: 8, sinceDays: 30 }).catch(() => []),
  ])

  const projects = new Map()
  for (const r of rooms.rows) {
    const key = canonicalProject(r.project_name) ?? '(ยังไม่ระบุโครงการ)'
    const p = projects.get(key) ?? { project: key, rooms: 0, available: 0, rentSum: 0, views: 0 }
    p.rooms += 1
    if (r.status === 'available') p.available += 1
    p.rentSum += Number(r.monthly_rent || 0)
    p.views += Number(r.view_count || 0)
    projects.set(key, p)
  }
  const byProject = [...projects.values()]
    .map(({ rentSum, ...p }) => ({ ...p, avgRent: p.rooms ? Math.round(rentSum / p.rooms) : 0 }))
    .sort((a, b) => b.rooms - a.rooms || a.project.localeCompare(b.project, 'th'))

  const t = totals.rows[0]
  res.json({
    totals: {
      roomsTotal:     t.rooms_total,
      roomsAvailable: t.rooms_available,
      roomsReserved:  t.rooms_reserved,
      roomsPending:   t.rooms_pending,
      tenants:        t.tenants,
      landlords:      t.landlords,
      inboxOpen:      t.inbox_open,
      viewingsWeek:   t.viewings_week,
    },
    byProject,
    byZone: zones.rows.map((z) => ({
      zone: z.zone, rooms: z.rooms, available: z.available,
      avgRent: z.avg_rent ?? 0, views: z.views,
    })),
    topInterest,
  })
}))
