import { z } from 'zod';
import { NOTIFICATION_TYPES } from '../enums.js';

export const notificationItem = z.object({
  id: z.string(),
  type: z.enum(NOTIFICATION_TYPES),
  title: z.string(),
  body: z.string(),
  /** Optional in-app deep link, e.g. /reports/<id>. */
  href: z.string().nullable(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type NotificationItem = z.infer<typeof notificationItem>;

export const listNotificationsQuery = z.object({
  unreadOnly: z.coerce.boolean().default(false),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuery>;

export const markNotificationsReadInput = z.object({
  /** Omit to mark everything read. */
  ids: z.array(z.string()).max(200).optional(),
});
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadInput>;
