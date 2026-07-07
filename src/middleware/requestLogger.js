// src/middleware/requestLogger.js — Tiny request logger (no morgan dep).
import { logger } from '../logger.js'

export function requestLogger() {
  return (req, res, next) => {
    const start = process.hrtime.bigint()
    res.on('finish', () => {
      const ms = Number((process.hrtime.bigint() - start) / 1_000_000n)
      logger.info(
        {
          method: req.method,
          url:    req.originalUrl,
          status: res.statusCode,
          ms,
          reqId:  req.id,
        },
        'request'
      )
    })
    next()
  }
}