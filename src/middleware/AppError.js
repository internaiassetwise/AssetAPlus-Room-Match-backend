// src/middleware/AppError.js — Typed operational error for route handlers.
export class AppError extends Error {
  /**
   * @param {number} status  HTTP status code
   * @param {string} code    Stable machine code (UPPER_SNAKE_CASE)
   * @param {string} message Human-readable, safe to send to clients
   * @param {object} [details] Optional structured detail (e.g. zod issues)
   */
  constructor(status, code, message, details) {
    super(message)
    this.name    = 'AppError'
    this.status  = status
    this.code    = code
    this.details = details
  }
}