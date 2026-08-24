import { z } from 'zod';

/**
 * Shared primitive schemas. Written for Zod 4 (top-level string formats,
 * `z.email()` etc.). Keep everything that more than one domain file needs here
 * so validation rules stay consistent across the API surface.
 */

/** A MongoDB ObjectId as a 24-char hex string. */
export const objectId = z
  .string()
  .regex(/^[a-f0-9]{24}$/i, 'Must be a 24-character hex id');

export const email = z.email('Enter a valid email address').max(254).toLowerCase().trim();

/**
 * E.164 phone number. We validate shape, not existence. Normalisation (adding a
 * default country code, stripping spaces) happens before hashing on the server.
 */
export const phone = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Use international format, e.g. +8801XXXXXXXXX');

export const password = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200, 'That is too long')
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), {
    error: 'Include upper- and lower-case letters and a number',
  });

export const otpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const displayName = z.string().trim().min(2, 'Too short').max(80, 'Too long');

/** Free-text narrative fields: trimmed, bounded, non-empty. */
export function narrative(min: number, max: number) {
  return z.string().trim().min(min, `Please write at least ${min} characters`).max(max);
}

/** Cursor pagination params usable by any list endpoint. */
export const pagination = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof pagination>;

/** Standard error body returned by the API's error handler. */
export const apiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBody>;
