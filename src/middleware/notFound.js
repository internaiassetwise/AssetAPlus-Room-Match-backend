// src/middleware/notFound.js — 404 for unmatched /api/* routes.
import { AppError } from './AppError.js'

export function notFound() {
  return (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'ไม่พบ endpoint นี้'))
}