// src/middleware/error.js — Final error handler: turns everything into JSON.
import { ZodError } from 'zod'
import { AppError } from './AppError.js'
import { logger } from '../logger.js'

export function errorHandler() {
  // 4 args is intentional — Express detects this as the error handler
  return (err, req, res, _next) => {
    let status = 500
    let code   = 'INTERNAL_ERROR'
    let message = 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์'
    let details

    if (err instanceof AppError) {
      status  = err.status
      code    = err.code
      message = err.message
      details = err.details
    } else if (err instanceof ZodError) {
      status  = 400
      code    = 'VALIDATION_ERROR'
      message = 'ข้อมูลไม่ถูกต้อง'
      details = err.issues
    } else if (err?.code === '23505') {     // Postgres unique violation
      status  = 409
      code    = 'DUPLICATE'
      message = 'ข้อมูลซ้ำ'
    } else if (err?.code === '23503') {     // Postgres FK violation
      status  = 400
      code    = 'FK_VIOLATION'
      message = 'ข้อมูลอ้างอิงไม่ถูกต้อง'
    } else if (err?.type === 'entity.parse.failed') {  // express.json malformed body
      status  = 400
      code    = 'BAD_JSON'
      message = 'รูปแบบ JSON ไม่ถูกต้อง'
    }

    if (status >= 500) {
      logger.error({ err, reqId: req.id }, 'request failed')
    } else {
      logger.warn({ err: { code: err.code, message: err.message }, reqId: req.id }, 'request rejected')
    }

    res.status(status).json({
      ok: false,
      error: { code, message, ...(details ? { details } : {}) },
      requestId: req.id,
    })
  }
}