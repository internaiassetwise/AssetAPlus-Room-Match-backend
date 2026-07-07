// src/auth/middleware.js — Gate routes that need an authenticated public user.
//
// Two middlewares:
//
//   requireUser     — gates tenant-side actions (viewings, inquiries, prefs).
//                     Reads `user_session` cookie and looks up the row.
//   requireLandlord — gates landlord-side actions (my-listings, inquiry inbox).
//                     Reads `landlord_session` cookie and looks up the row.
//
// Both follow the same shape as requireAdmin — readCookie → repo lookup →
// attach to req → next. If the cookie is missing or the session expired they
// throw AppError(401, 'AUTH_REQUIRED' | 'AUTH_INVALID').
//
// Persona-based mock login (POST /auth/mock/login) exercises the SAME code path
// by writing real rows into user_sessions / landlord_sessions and setting the
// matching cookie. There is no env-var shortcut here — mock and real auth flow
// through identical middleware. `MOCK_AUTH` only gates the mock-login endpoint
// itself, not the middlewares.

import { findUserSession }     from '../db/repositories/userSessions.repo.js'
import { findLandlordSession } from '../db/repositories/landlordSessions.repo.js'
import { AppError } from '../middleware/AppError.js'
import {
  USER_COOKIE, LANDLORD_COOKIE, readCookie,
} from './sessions.js'

/**
 * Reads `user_session` cookie, looks up the row, attaches `req.user`.
 * Throws AppError(401, 'AUTH_REQUIRED') when missing/invalid.
 */
export async function requireUser(req, _res, next) {
  try {
    const token = readCookie(req, USER_COOKIE)
    if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'กรุณาเข้าสู่ระบบในฐานะผู้เช่าก่อน')
    const session = await findUserSession(token)
    if (!session) throw new AppError(401, 'AUTH_INVALID', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่')
    req.user = {
      id:      session.tenant_id,
      email:   session.email,
      name:    session.full_name,
      picture: session.picture_url,
      role:    'tenant',
    }
    next()
  } catch (err) {
    next(err)
  }
}

/**
 * Landlord counterpart. Attaches `req.landlord = { id, name, email, phone, role }`.
 * Requires a valid `landlord_session` cookie. The mock-login endpoint seeds the
 * row when MOCK_AUTH=true; real OAuth would land here later.
 */
export async function requireLandlord(req, _res, next) {
  try {
    const token = readCookie(req, LANDLORD_COOKIE)
    if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'กรุณาเข้าสู่ระบบในฐานะเจ้าของห้องก่อน')
    const session = await findLandlordSession(token)
    if (!session) throw new AppError(401, 'AUTH_INVALID', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่')
    req.landlord = {
      id:      session.landlord_id,
      name:    session.full_name,
      email:   session.email,
      phone:   session.phone,
      lineId:  session.line_id,
      company: session.company_name,
      role:    'landlord',
    }
    next()
  } catch (err) {
    next(err)
  }
}
