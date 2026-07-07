// src/routes/dashboard.js — Landlord KPI dashboard.
//
// Returns aggregated numbers for the dashboard tiles + recent activity feed.
// Identity comes from the landlord_session cookie via requireLandlord —
// persona-based mock login sets the same cookie that real OAuth will.

import { Router } from 'express'
import * as dashboard from '../db/repositories/dashboard.repo.js'
import * as viewings  from '../db/repositories/viewings.repo.js'
import * as inquiries from '../db/repositories/inquiries.repo.js'
import { asyncHandler }       from '../middleware/_asyncHandler.js'
import { requireLandlord }    from '../auth/middleware.js'

export const dashboardRouter = Router()

dashboardRouter.get('/', requireLandlord, asyncHandler(async (req, res) => {
  const landlordId = req.landlord.id

  const [
    totalRooms,
    availableRooms,
    inquiriesThisWeek,
    upcomingViewings,
    occupancyPct,
    recentInq,
    recentVw,
  ] = await Promise.all([
    dashboard.countRooms(landlordId),
    dashboard.countByStatus(landlordId, 'available'),
    inquiries.countSinceForLandlord(landlordId, 7),
    viewings.countUpcomingForLandlord(landlordId),
    dashboard.occupancyRate(landlordId),
    dashboard.recentInquiries(landlordId, 5),
    dashboard.recentViewings(landlordId, 5),
  ])

  res.json({
    totalRooms,
    availableRooms,
    inquiriesThisWeek,
    upcomingViewings,
    occupancyRate: occupancyPct,
    recentInquiries: recentInq,
    recentViewings:  recentVw,
  })
}))