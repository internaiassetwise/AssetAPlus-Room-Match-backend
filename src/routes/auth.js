// src/routes/auth.js — Admin login / logout / session check.
import { Router } from 'express'
import { z } from 'zod'
import * as admins from '../db/repositories/admins.repo.js'
import { asyncHandler }     from '../middleware/_asyncHandler.js'
import { validate }         from '../middleware/validate.js'
import { AppError }         from '../middleware/AppError.js'
import { requireAdmin, ADMIN_COOKIE, readCookie } from '../middleware/requireAdmin.js'
import { isProd } from '../config.js'

export const auth = Router()

const loginBody = z.object({
  username: z.string().trim().min(1, 'กรุณากรอกชื่อผู้ใช้').max(120),
  password: z.string().min(1, 'กรุณากรอกรหัสผ่าน').max(200),
})

auth.post('/login', validate({ body: loginBody }), asyncHandler(async (req, res) => {
  const { username, password } = req.body
  const admin = await admins.findByUsername(username)
  if (!admin || !admin.is_active) {
    throw new AppError(401, 'AUTH_BAD_CREDENTIALS', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง')
  }
  const ok = await admins.verifyPassword(password, admin.password_hash)
  if (!ok) {
    throw new AppError(401, 'AUTH_BAD_CREDENTIALS', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง')
  }
  const { token, expiresAt } = await admins.createSession(admin.id)
  await admins.touchLastLogin(admin.id)
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    expires: expiresAt,
    path: '/',
  })
  res.json({ id: admin.id, username: admin.username })
}))

auth.post('/logout', asyncHandler(async (req, res) => {
  const token = readCookie(req, ADMIN_COOKIE)
  if (token) await admins.destroySession(token)
  res.clearCookie(ADMIN_COOKIE, { path: '/' })
  res.json({ ok: true })
}))

auth.get('/me', requireAdmin, asyncHandler(async (req, res) => {
  res.json({ id: req.admin.id, username: req.admin.username })
}))