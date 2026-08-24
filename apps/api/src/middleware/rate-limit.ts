import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request } from 'express';
import { isTest } from '../config/env.js';

/**
 * Rate limiters. Auth and search are the surfaces most worth protecting:
 * credential stuffing on login, OTP brute force, and search abuse (using the
 * platform to probe whether identifiers are known).
 *
 * Limits are disabled under NODE_ENV=test so the integration suite isn't
 * throttled. In production with multiple instances these should move to a
 * shared Redis store; the in-memory store is per-process.
 */

function keyByIpAndAccount(req: Request): string {
  // Combine IP with the target email when present, so one attacker can't lock
  // out an entire NAT'd office, and one victim email can't be hammered from
  // many IPs without each IP also being limited.
  const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : '';
  return `${req.ip}|${email}`;
}

const disabled: RateLimitRequestHandler = ((_req, _res, next) => next()) as RateLimitRequestHandler;

export const authLimiter: RateLimitRequestHandler = isTest
  ? disabled
  : rateLimit({
      windowMs: 15 * 60_000,
      limit: 10,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: keyByIpAndAccount,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } },
    });

export const otpLimiter: RateLimitRequestHandler = isTest
  ? disabled
  : rateLimit({
      windowMs: 10 * 60_000,
      limit: 6,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: keyByIpAndAccount,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many codes requested. Try again later.' } },
    });

export const searchLimiter: RateLimitRequestHandler = isTest
  ? disabled
  : rateLimit({
      windowMs: 60_000,
      limit: 20,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many searches. Slow down a moment.' } },
    });

export const writeLimiter: RateLimitRequestHandler = isTest
  ? disabled
  : rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'RATE_LIMITED', message: 'You are doing that too quickly.' } },
    });
