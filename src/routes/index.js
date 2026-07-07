// src/routes/index.js — Mount every resource under /api and /api/v1.
import { Router } from 'express'
import { health }      from './health.js'
import { rooms }       from './rooms.js'
import { zones }       from './zones.js'
import { reviews }     from './reviews.js'
import { stats }       from './stats.js'
import { preferences } from './preferences.js'
import { contact }     from './contact.js'
import { matches }     from './matches.js'
import { landlords }   from './landlords.js'
import { auth }        from './auth.js'

export const apiRouter = Router()

// Versioned
apiRouter.use('/v1/health',      health)
apiRouter.use('/v1/rooms',       rooms)
apiRouter.use('/v1/zones',       zones)
apiRouter.use('/v1/reviews',     reviews)
apiRouter.use('/v1/stats',       stats)
apiRouter.use('/v1/preferences', preferences)
apiRouter.use('/v1/contact',     contact)
apiRouter.use('/v1/matches',     matches)
apiRouter.use('/v1/landlords',   landlords)
apiRouter.use('/v1/auth',        auth)

// Unversioned aliases (kept for backward compat with current client)
apiRouter.use('/health',      health)
apiRouter.use('/rooms',       rooms)
apiRouter.use('/zones',       zones)
apiRouter.use('/reviews',     reviews)
apiRouter.use('/stats',       stats)
apiRouter.use('/preferences', preferences)
apiRouter.use('/contact',     contact)
apiRouter.use('/matches',     matches)
apiRouter.use('/landlords',   landlords)
apiRouter.use('/auth',        auth)