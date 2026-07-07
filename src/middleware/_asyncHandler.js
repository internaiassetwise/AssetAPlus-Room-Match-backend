// src/middleware/_asyncHandler.js — Wrap an async route so rejections land in error mw.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)