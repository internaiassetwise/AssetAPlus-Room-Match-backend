// src/middleware/requireAdmin.js — Gate routes that need an authenticated staff session.
import { findSession } from '../db/repositories/admins.repo.js'
import { AppError } from './AppError.js'

export const ADMIN_COOKIE = 'admin_session'

/** Parse a single cookie name from the raw Cookie header. */
export function readCookie(req, name) {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const k = part.slice(0, eq).trim()
    if (k !== name) continue
    try { return decodeURIComponent(part.slice(eq + 1).trim()) } catch { return null }
  }
  return null
}

export async function requireAdmin(req, _res, next) {
  try {
    const token = readCookie(req, ADMIN_COOKIE)
    if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'ต้องเข้าสู่ระบบก่อน')
    const session = await findSession(token)
    if (!session) throw new AppError(401, 'AUTH_INVALID', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่')
    // Carry the full identity so every handler + the audit middleware can
    // attribute the action to a specific Microsoft/Azure admin (azure_oid)
    // or a local-login admin (username).
    req.admin = {
      id:          session.id,
      username:    session.username,
      displayName: session.display_name || session.username,
      email:       session.email || null,
      azureOid:    session.azure_oid || null,
    }
    next()
  } catch (err) {
    next(err)
  }
}