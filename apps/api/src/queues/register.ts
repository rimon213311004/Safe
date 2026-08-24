import { registerHandler } from './index.js';
import { completeEvidenceScan } from '../modules/evidence/evidence.service.js';
import { createNotification } from '../modules/notifications/notification.service.js';
import { NOTIFICATION_TYPES, type NotificationType } from '@safecheck/shared';
import { logger } from '../lib/logger.js';

/**
 * Job handler registration.
 *
 * Kept separate from queues/index.ts so that services can import the `enqueue*`
 * helpers without creating an import cycle back through themselves. Called once
 * from createApp(), which also means the inline fallback has its handlers in
 * place before any request can enqueue work.
 */

let registered = false;

export function registerQueueHandlers(): void {
  if (registered) return;
  registered = true;

  registerHandler('evidence-scan', async (payload) => {
    const evidenceId = payload.evidenceId;
    if (typeof evidenceId !== 'string') {
      logger.warn({ payload }, 'evidence-scan job missing evidenceId');
      return;
    }
    await completeEvidenceScan(evidenceId);
  });

  // notifications and retention handlers are registered by their own modules
  // as those land; an unregistered queue logs and drops rather than throwing.
  registerHandler('notifications', async (payload) => {
    const { userId, type, title, body } = payload;
    if (typeof userId !== 'string' || typeof title !== 'string' || typeof body !== 'string') {
      logger.warn({ payload }, 'notification job missing required fields');
      return;
    }
    // The queue payload is loosely typed by design (queues/index.ts takes a plain
    // record), so the notification type is re-validated here rather than cast —
    // an unknown value would otherwise fail the model's enum at write time and be
    // swallowed as a job failure.
    if (typeof type !== 'string' || !(NOTIFICATION_TYPES as readonly string[]).includes(type)) {
      logger.warn({ type }, 'notification job has unknown type');
      return;
    }

    await createNotification({
      userId,
      type: type as NotificationType,
      title,
      body,
      href: typeof payload.href === 'string' ? payload.href : null,
    });
  });
}
