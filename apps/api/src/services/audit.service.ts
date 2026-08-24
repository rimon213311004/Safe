import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { AuditAction, Role } from '@safecheck/shared';
import { AuditLog } from '../models/index.js';
import { logger } from '../lib/logger.js';

/**
 * Append-only audit writer. This is the ONLY way the app writes audit rows —
 * there is intentionally no update or delete. Failures are logged but never
 * throw into the request path: an audit write failing should not, for example,
 * block a user from reading evidence they're entitled to. (In a higher-assurance
 * deployment you might make certain audit writes blocking; noted, not done.)
 */

export interface AuditContext {
  actorId?: string | null;
  actorRole?: Role | null;
  ipHash?: string | null;
  userAgent?: string;
}

/** Hash an IP so we can correlate activity without storing a location trail. */
export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

export function auditContextFromRequest(req: Request): AuditContext {
  return {
    actorId: req.auth?.userId ?? null,
    actorRole: req.auth?.role ?? null,
    ipHash: hashIp(req.ip),
    userAgent: (req.get('user-agent') ?? '').slice(0, 300),
  };
}

export async function recordAudit(
  action: AuditAction,
  params: {
    context?: AuditContext;
    targetType?: string;
    targetId?: string;
    meta?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    await AuditLog.create({
      action,
      actorId: params.context?.actorId ?? null,
      actorRole: params.context?.actorRole ?? null,
      targetType: params.targetType ?? null,
      targetId: params.targetId ?? null,
      meta: params.meta ?? {},
      ipHash: params.context?.ipHash ?? null,
      userAgent: params.context?.userAgent ?? '',
      at: new Date(),
    });
  } catch (err) {
    logger.error({ err, action }, 'failed to write audit log');
  }
}
