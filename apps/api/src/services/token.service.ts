import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Role } from '@safecheck/shared';
import { env } from '../config/env.js';
import { hashToken, randomToken } from '../lib/crypto.js';
import { Session } from '../models/index.js';
import { unauthenticated } from '../lib/errors.js';
import { recordAudit } from './audit.service.js';
import { logger } from '../lib/logger.js';

/**
 * Access + refresh token handling.
 *
 * Access tokens are short-lived signed JWTs (stateless, ~10 min). Refresh tokens
 * are opaque random strings stored ONLY as HMAC hashes, and they rotate on every
 * use.
 *
 * Rotation with reuse detection is the important part. Each login starts a
 * `family`. Using a refresh token mints a successor in the same family and marks
 * the predecessor rotated. If a rotated token is presented again, either the
 * client is buggy or a stolen token is being replayed — we cannot tell which, so
 * we revoke the entire family and force re-authentication. That converts token
 * theft from "attacker has persistent access" into "attacker gets one request,
 * and the legitimate user is logged out and can be alerted".
 */

const ACCESS_ISSUER = 'safecheck';
const ACCESS_AUDIENCE = 'safecheck-web';

const accessKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

export interface AccessClaims extends JWTPayload {
  sub: string;
  role: Role;
  fam: string;
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
}

export async function signAccessToken(params: {
  userId: string;
  role: Role;
  sessionFamily: string;
}): Promise<IssuedAccessToken> {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ role: params.role, fam: params.sessionFamily })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(params.userId)
    .setIssuer(ACCESS_ISSUER)
    .setAudience(ACCESS_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
    .sign(accessKey);

  const { payload } = await jwtVerify(token, accessKey, {
    issuer: ACCESS_ISSUER,
    audience: ACCESS_AUDIENCE,
  });
  return { token, expiresAt: new Date((payload.exp ?? now) * 1000) };
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, accessKey, {
      issuer: ACCESS_ISSUER,
      audience: ACCESS_AUDIENCE,
    });
    if (typeof payload.sub !== 'string' || typeof payload.fam !== 'string') {
      throw new Error('malformed claims');
    }
    return payload as AccessClaims;
  } catch {
    // Never surface the underlying jose error — it distinguishes expired from
    // malformed from wrong-signature, which is more than a caller needs.
    throw unauthenticated('Your session has expired. Please sign in again.');
  }
}

/* ------------------------------------------------------------------ refresh */

export interface IssuedRefreshToken {
  token: string;
  family: string;
  expiresAt: Date;
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
}

/** Start a brand-new session family (i.e. a fresh login on a new device). */
export async function issueRefreshToken(params: {
  userId: string;
  userAgent?: string;
  ip?: string;
}): Promise<IssuedRefreshToken> {
  const token = randomToken(32);
  const family = randomToken(16);
  const expiresAt = refreshExpiry();

  await Session.create({
    userId: params.userId,
    family,
    refreshTokenHash: hashToken(token),
    userAgent: (params.userAgent ?? '').slice(0, 300),
    ip: params.ip ?? '',
    expiresAt,
  });

  return { token, family, expiresAt };
}

export interface RotationResult {
  userId: string;
  refresh: IssuedRefreshToken;
}

/**
 * Exchange a refresh token for a successor.
 *
 * Throws `unauthenticated` for every failure mode, including reuse — the client
 * is told only "sign in again". The distinction is recorded in the audit log,
 * not returned to the caller.
 */
export async function rotateRefreshToken(presentedToken: string): Promise<RotationResult> {
  const presentedHash = hashToken(presentedToken);
  const session = await Session.findOne({ refreshTokenHash: presentedHash });

  if (!session) throw unauthenticated('Your session has expired. Please sign in again.');

  // Family already revoked (logout, or a prior reuse detection).
  if (session.revokedAt) {
    throw unauthenticated('Your session has expired. Please sign in again.');
  }

  // ── Reuse detection ─────────────────────────────────────────────────────
  // This token was already exchanged. Someone is replaying it. We can't tell a
  // stolen token from a buggy client, so we assume the worst and revoke the
  // whole family.
  if (session.rotatedAt) {
    await Session.updateMany(
      { family: session.family, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'refresh_token_reuse_detected' } },
    );
    logger.warn(
      { family: session.family, userId: String(session.userId) },
      'refresh token reuse detected — family revoked',
    );
    await recordAudit('auth.token_reuse_detected', {
      context: { actorId: String(session.userId) },
      targetType: 'Session',
      targetId: String(session._id),
      meta: { family: session.family },
    });
    throw unauthenticated('Your session has expired. Please sign in again.');
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    throw unauthenticated('Your session has expired. Please sign in again.');
  }

  // Mint the successor inside the same family.
  const nextToken = randomToken(32);
  const expiresAt = refreshExpiry();

  session.rotatedAt = new Date();
  await session.save();

  await Session.create({
    userId: session.userId,
    family: session.family,
    refreshTokenHash: hashToken(nextToken),
    userAgent: session.userAgent,
    ip: session.ip,
    expiresAt,
  });

  return {
    userId: String(session.userId),
    refresh: { token: nextToken, family: session.family, expiresAt },
  };
}

/** Revoke one family (single-device logout). */
export async function revokeFamily(family: string, reason: string): Promise<void> {
  await Session.updateMany(
    { family, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}

/** Revoke every session for a user (password change, account compromise). */
export async function revokeAllSessions(userId: string, reason: string): Promise<void> {
  await Session.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}
