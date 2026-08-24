import { Types } from 'mongoose';
import type {
  ListNotificationsQuery,
  NotificationItem,
  NotificationType,
} from '@safecheck/shared';
import { Notification } from '../../models/index.js';

/**
 * Notification service.
 *
 * In-app notifications only. Anything that must reach a person who may not be
 * signed in — a subject being told a decision concerns them — goes out through
 * messaging.service.ts instead, because a row in this collection is worthless to
 * someone with no account.
 *
 * Bodies here are written on the assumption they may be read on a lock screen.
 * They say that something happened and where to look; they never quote an
 * allegation, name a reporter, or state an outcome.
 */

/** Create a notification. Returns the id so a caller can log delivery. */
export async function createNotification(params: {
  userId: string | Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  href?: string | null;
}): Promise<string> {
  const doc = await Notification.create({
    userId: new Types.ObjectId(params.userId.toString()),
    type: params.type,
    title: params.title,
    body: params.body,
    href: params.href ?? null,
  });
  return doc._id.toString();
}

/* -------------------------------------------------------------------- reads */

/**
 * List a user's notifications, newest first.
 *
 * The cursor is the last `_id` from the previous page rather than a timestamp: an
 * ObjectId leads with its creation time, so `_id` descending is the same ordering
 * as `createdAt` descending, and it stays stable when two rows share a
 * millisecond. A timestamp cursor would skip or repeat rows in that case.
 */
export async function listNotifications(params: {
  userId: string;
  query: ListNotificationsQuery;
}): Promise<{ notifications: NotificationItem[]; nextCursor: string | null }> {
  const filter: Record<string, unknown> = {
    userId: new Types.ObjectId(params.userId),
  };
  if (params.query.unreadOnly) filter.readAt = null;
  if (params.query.cursor && Types.ObjectId.isValid(params.query.cursor)) {
    filter._id = { $lt: new Types.ObjectId(params.query.cursor) };
  }

  // Fetch one extra to learn whether a further page exists without a count().
  const rows = await Notification.find(filter)
    .sort({ _id: -1 })
    .limit(params.query.limit + 1)
    .lean();

  const page = rows.slice(0, params.query.limit);
  const nextCursor =
    rows.length > params.query.limit && page.length > 0
      ? page[page.length - 1]!._id.toString()
      : null;

  return { notifications: page.map(toNotificationItem), nextCursor };
}

export async function unreadCount(userId: string): Promise<number> {
  return Notification.countDocuments({
    userId: new Types.ObjectId(userId),
    readAt: null,
  });
}

/* ------------------------------------------------------------------- writes */

/**
 * Mark notifications read. Scoped to the caller's own rows, so a supplied id
 * belonging to someone else matches nothing rather than erroring — which would
 * confirm that the id exists.
 */
export async function markRead(params: {
  userId: string;
  ids?: string[];
}): Promise<{ updated: number }> {
  const filter: Record<string, unknown> = {
    userId: new Types.ObjectId(params.userId),
    readAt: null,
  };

  if (params.ids) {
    const valid = params.ids.filter((id) => Types.ObjectId.isValid(id));
    // An explicit empty selection updates nothing, rather than falling through to
    // "mark everything" — omitting `ids` is how a caller asks for that.
    if (valid.length === 0) return { updated: 0 };
    filter._id = { $in: valid.map((id) => new Types.ObjectId(id)) };
  }

  const result = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
  return { updated: result.modifiedCount };
}

/* ------------------------------------------------------------ serialisation */

function toNotificationItem(row: {
  _id: Types.ObjectId;
  type: string;
  title: string;
  body: string;
  href?: string | null;
  readAt?: Date | null;
  createdAt?: Date;
}): NotificationItem {
  return {
    id: row._id.toString(),
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    href: row.href ?? null,
    readAt: row.readAt?.toISOString() ?? null,
    // `timestamps: true` guarantees createdAt on every row written through the
    // model; the fallback keeps the serialiser total for hand-inserted fixtures.
    createdAt: (row.createdAt ?? row._id.getTimestamp()).toISOString(),
  };
}
