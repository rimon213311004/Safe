import { Router, type Request, type Response } from 'express';
import { notificationSchemas } from '@safecheck/shared';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { body, query, validate } from '../../middleware/validate.js';
import * as notificationService from './notification.service.js';

/**
 * Notification routes. Every route is scoped to the caller's own rows — there is
 * no id in any path, so one user's notifications are not addressable by another.
 */

export const notificationRouter = Router();

notificationRouter.use(requireAuth);

notificationRouter.get(
  '/',
  validate({ query: notificationSchemas.listNotificationsQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const { notifications, nextCursor } = await notificationService.listNotifications({
      userId: req.auth!.userId,
      query: query<notificationSchemas.ListNotificationsQuery>(req),
    });
    res.status(200).json({
      notifications,
      nextCursor,
      unread: await notificationService.unreadCount(req.auth!.userId),
    });
  }),
);

notificationRouter.post(
  '/read',
  validate({ body: notificationSchemas.markNotificationsReadInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const { updated } = await notificationService.markRead({
      userId: req.auth!.userId,
      ids: body<notificationSchemas.MarkNotificationsReadInput>(req).ids,
    });
    res.status(200).json({
      updated,
      unread: await notificationService.unreadCount(req.auth!.userId),
    });
  }),
);
