import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import type { IdentifierType } from '@safecheck/shared';
import { env } from '../config/env.js';

/**
 * Cryptographic primitives for SafeCheck.
 *
 * Two responsibilities live here and nowhere else:
 *   1. Deterministic, peppered hashing of subject identifiers, so the database
 *      contains no browsable directory of reported people.
 *   2. AES-256-GCM encryption of evidence at rest.
 *
 * Keys come from env (validated at boot). Never log anything this module takes
 * as input.
 */

/* ----------------------------------------------------- identifier normalise */

/**
 * Canonicalise an identifier before hashing so that "+880 1700-000000",
 * "+8801700000000", and " a@B.com " all match their stored hash. Matching must
 * survive superficial formatting differences or the whole lookup fails silently.
 */
export function normalizeIdentifier(type: IdentifierType, raw: string): string {
  const trimmed = raw.trim();
  if (type === 'email') return trimmed.toLowerCase();
  // phone: strip everything that isn't a digit or a leading '+'
  const plus = trimmed.startsWith('+') ? '+' : '';
  return plus + trimmed.replace(/[^\d]/g, '');
}

/**
 * Peppered HMAC-SHA256 of a normalised identifier. Deterministic (same input →
 * same output) so it can be indexed and looked up, but not reversible or
 * brute-forceable without IDENTIFIER_PEPPER. The type is bound into the hash so
 * an email and a phone that happen to share a string can't collide.
 */
export function hashIdentifier(type: IdentifierType, raw: string): string {
  const normalized = normalizeIdentifier(type, raw);
  return createHmac('sha256', env.IDENTIFIER_PEPPER)
    .update(`${type}:${normalized}`)
    .digest('hex');
}

/* -------------------------------------------------------------- OTP + hashes */

/** Cryptographically-uniform 6-digit code (leading zeros preserved). */
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Hash short secrets (OTPs, opaque refresh tokens) for storage. These are
 * high-entropy or short-lived, so a fast keyed hash is appropriate and lets us
 * compare in constant time. (User passwords use argon2 instead — see auth.)
 */
export function hashToken(value: string): string {
  return createHmac('sha256', env.JWT_REFRESH_SECRET).update(value).digest('hex');
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Opaque, URL-safe random token for refresh tokens and signed-URL nonces. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison that won't throw on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* --------------------------------------------------- evidence encryption */

const ALGO = 'aes-256-gcm';

/** Derive a 32-byte key from the configured hex/base64 secret. */
function evidenceKey(): Buffer {
  // Accept hex or base64-ish secrets; normalise to exactly 32 bytes via SHA-256.
  return createHash('sha256').update(env.EVIDENCE_ENCRYPTION_KEY).digest();
}

export interface EncryptedBlob {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export function encryptBuffer(plaintext: Buffer): EncryptedBlob {
  const iv = randomBytes(12); // 96-bit nonce, standard for GCM
  const cipher = createCipheriv(ALGO, evidenceKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptBuffer(blob: EncryptedBlob): Buffer {
  const decipher = createDecipheriv(ALGO, evidenceKey(), blob.iv);
  decipher.setAuthTag(blob.authTag);
  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
}
