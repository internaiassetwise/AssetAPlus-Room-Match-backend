// src/logger.js — Pino logger with pretty output in dev, JSON in prod.
import pino from 'pino'
import { config, isProd } from './config.js'

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'room-match-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProd
    ? {} // production: structured JSON
    : {
        // development: human-friendly transport
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
        },
      }),
})

export default logger