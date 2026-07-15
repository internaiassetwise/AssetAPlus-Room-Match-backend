// src/routes/index.js — Mount every resource under /api and /api/v1.
import { Router } from 'express'
import { health }         from './health.js'
import { rooms }          from './rooms.js'
import { zones }          from './zones.js'
import { reviews }        from './reviews.js'
import { stats }          from './stats.js'
import { preferences }    from './preferences.js'
import { contact }        from './contact.js'
import { matches }        from './matches.js'
import { landlords }      from './landlords.js'
import { auth }           from './auth.js'
import { viewings }       from './viewings.js'
import { inquiries }      from './inquiries.js'
import { myListings }     from './my-listings.js'
import { liff }           from './liff.js'
import { dashboardRouter } from './dashboard.js'
import { faqs }           from './faqs.js'
import { botInquiries }   from './botInquiries.js'
import { adminInbox }     from './adminInbox.js'
import { adminViewings }  from './adminViewings.js'
import { leads }          from './leads.js'
import lineWebhook        from '../linebot/lineWebhook.route.js'
import { lineDebug }      from '../linebot/lineDebug.route.js'

export const apiRouter = Router()

// Versioned
apiRouter.use('/v1/health',         health)
apiRouter.use('/v1/rooms',          rooms)
apiRouter.use('/v1/zones',          zones)
apiRouter.use('/v1/reviews',        reviews)
apiRouter.use('/v1/stats',          stats)
apiRouter.use('/v1/preferences',    preferences)
apiRouter.use('/v1/contact',        contact)
apiRouter.use('/v1/matches',        matches)
apiRouter.use('/v1/landlords',      landlords)
apiRouter.use('/v1/auth',           auth)
apiRouter.use('/v1/viewings',       viewings)
apiRouter.use('/v1/inquiries',      inquiries)
apiRouter.use('/v1/my-listings',    myListings)
apiRouter.use('/v1/liff',           liff)
apiRouter.use('/v1/dashboard',      dashboardRouter)
apiRouter.use('/v1/faqs',           faqs)
apiRouter.use('/v1/line/webhook',  lineWebhook)
apiRouter.use('/v1/line/debug',      lineDebug)
apiRouter.use('/v1/admin/bot-inquiries', botInquiries)
apiRouter.use('/v1/admin/inbox',         adminInbox)
apiRouter.use('/v1/admin/viewings',      adminViewings)
apiRouter.use('/v1/leads',          leads)

// Unversioned aliases (kept for backward compat with current client)
apiRouter.use('/health',         health)
apiRouter.use('/rooms',          rooms)
apiRouter.use('/zones',          zones)
apiRouter.use('/reviews',        reviews)
apiRouter.use('/stats',          stats)
apiRouter.use('/preferences',    preferences)
apiRouter.use('/contact',        contact)
apiRouter.use('/matches',        matches)
apiRouter.use('/landlords',      landlords)
apiRouter.use('/auth',           auth)
apiRouter.use('/viewings',       viewings)
apiRouter.use('/inquiries',      inquiries)
apiRouter.use('/my-listings',    myListings)
apiRouter.use('/liff',           liff)
apiRouter.use('/dashboard',      dashboardRouter)
apiRouter.use('/faqs',           faqs)
apiRouter.use('/line/webhook',   lineWebhook)
apiRouter.use('/line/debug',      lineDebug)
apiRouter.use('/admin/bot-inquiries',   botInquiries)
apiRouter.use('/admin/inbox',           adminInbox)
apiRouter.use('/admin/viewings',        adminViewings)
apiRouter.use('/leads',           leads)