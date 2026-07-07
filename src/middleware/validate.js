// src/middleware/validate.js — zod-driven request validation.
//
// Usage:
//   import { z } from 'zod'
//   router.post('/foo', validate({ body: z.object({...}) }), handler)
import { AppError } from './AppError.js'

export function validate({ body, query, params } = {}) {
  return (req, _res, next) => {
    try {
      if (params) req.params = params.parse(req.params)
      if (query)  req.query  = query.parse(req.query)
      if (body)   req.body   = body.parse(req.body)
      next()
    } catch (err) {
      const issues = err?.issues?.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      }))
      next(new AppError(400, 'VALIDATION_ERROR', 'ข้อมูลไม่ถูกต้อง', issues || err.message))
    }
  }
}