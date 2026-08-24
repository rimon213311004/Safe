import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@safecheck/shared';
import { forbidden, unauthenticated } from '../lib/errors.js';
import { verifyAccessToken } from '../services/token.service.js';
import { Session, User } from '../models/index.js';

/**
 * Authentication and authorisation guards.
 *
 * requireAuth verifies the access token AND confirms the session family is still
 * live. Checking the family costs one indexed query but means revocation is
 * immediate rather than "whenever the 10-minute JWT expires" — which matters
 * when the revocation was triggered by detected token theft.
 */

function bearerFrom(req: Request): string | null {
  const header = req.get('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = bearerFrom(req);
    if (!token) throw unauthenticated();

    const claims = await verifyAccessToken(token);

    // Immediate revocation: a live session in this family must still exist.
    const liveSession = await Session.exists({
      family: claims.fam,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (!liveSession) throw unauthenticated('Your session has ended. Please sign in again.');

    req.auth = { userId: claims.sub, role: claims.role, sessionFamily: claims.fam };
    next();
  } catch (err) {
    next(err);
  }
}

/** Attach auth if a valid token is present, but allow anonymous access. */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = bearerFrom(req);
  if (!token) {
    next();
    return;
  }
  try {
    const claims = await verifyAccessToken(token);
    const liveSession = await Session.exists({
      family: claims.fam,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (liveSession) {
      req.auth = { userId: claims.sub, role: claims.role, sessionFamily: claims.fam };
    }
  } catch {
    // Ignore: this route tolerates anonymous callers.
  }
  next();
}

/**
 * Role gate. Roles are hierarchical for convenience: an admin satisfies a
 * moderator requirement. The role is re-read from the JWT claim, which is signed
 * — but see requireFreshRole below for the sensitive case.
 */
const RANK: Record<Role, number> = { user: 0, moderator: 1, admin: 2 };

export function requireRole(minimum: Role) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      next(unauthenticated());
      return;
    }
    if (RANK[req.auth.role] < RANK[minimum]) {
      next(forbidden('This area is restricted to moderators.'));
      return;
    }
    next();
  };
}

/**
 * Stricter role check that re-reads the role from the database.
 *
 * Use this on actions with irreversible consequences for a third party —
 * publishing a record, resolving an appeal. A signed JWT still carries the role
 * held when it was minted, so a demoted moderator could otherwise act for up to
 * the access-token TTL. For those specific endpoints that window is not
 * acceptable.
 */
export function requireFreshRole(minimum: Role) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.auth) throw unauthenticated();
      const user = await User.findById(req.auth.userId).select('role').lean();
      if (!user) throw unauthenticated();
      const current = user.role as Role;
      if (RANK[current] < RANK[minimum]) {
        throw forbidden('This action is restricted to moderators.');
      }
      // Keep req.auth honest for downstream handlers and audit rows.
      req.auth.role = current;
      next();
    } catch (err) {
      next(err);
    }
  };
}
