import pino from 'pino';
import { env, isDev, isTest } from '../config/env.js';

/**
 * Structured logger.
 *
 * Redaction is not cosmetic here: this app handles passwords, OTPs, tokens, and
 * subject identifiers. Anything on this list must never reach a log sink, since
 * logs are typically the least-protected copy of your data.
 */
export const logger = pino({
  level: isTest ? 'silent' : isDev ? 'debug' : 'info',
  redact: {
    paths: [
      'password',
      'newPassword',
      'currentPassword',
      'passwordHash',
      'code',
      'otp',
      'accessToken',
      'refreshToken',
      'authorization',
      'cookie',
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      // Subject identifiers: we log the hash, never the plaintext.
      'subject.email',
      'subject.phone',
      'identifier',
      'email',
      'phone',
    ],
    censor: '[redacted]',
  },
  base: { service: 'safecheck-api', env: env.NODE_ENV },
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined,
});

export type Logger = typeof logger;
