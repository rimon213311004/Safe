'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { NotificationItem } from '@safecheck/shared';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { formatDateTime, notificationLabel } from '@/lib/labels';
import { Badge, Callout, Card, Empty, Loading, PageHead, Segmented } from '@/components/ui';

/**
 * Notifications.
 *
 * Paged rather than fully loaded: the list is append-only and a long-lived account
 * accumulates one entry per status change on every report it touches. The cursor
 * comes from the API and is opaque here.
 *
 * Marking read is explicit. Opening the page does not clear the unread count,
 * because "a decision was issued about you" is exactly the kind of thing a person
 * should be able to leave flagged until they have dealt with it.
 */

type Filter = 'unread';

export default function NotificationsPage() {
  const [filter, setFilter] = useState<Filter | null>(null);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const more = useAction();
  const mark = useAction();

  const unreadOnly = filter === 'unread';

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.listNotifications({ unreadOnly, limit: 30 });
      setItems(page.notifications);
      setCursor(page.nextCursor);
      setUnread(page.unread);
    } catch {
      setError('Could not load your notifications. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [unreadOnly]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  async function onLoadMore() {
    if (!cursor) return;
    const page = await more.run(() => api.listNotifications({ unreadOnly, cursor, limit: 30 }));
    if (!page) return;
    // Appended, not replaced — and de-duplicated by id, because an entry created
    // between the two requests would otherwise appear on both pages.
    setItems((current) => {
      const seen = new Set(current.map((item) => item.id));
      return [...current, ...page.notifications.filter((item) => !seen.has(item.id))];
    });
    setCursor(page.nextCursor);
    setUnread(page.unread);
  }

  async function onMarkRead(ids?: string[]) {
    const result = await mark.run(() => api.markNotificationsRead(ids));
    if (!result) return;
    setUnread(result.unread);

    if (unreadOnly) {
      // The current view is "unread only", so anything just marked no longer
      // belongs in it. Reloading is more honest than filtering locally, since the
      // page may now be able to show older entries that were below the limit.
      void loadFirstPage();
      return;
    }
    const stamp = new Date().toISOString();
    setItems((current) =>
      current.map((item) =>
        (!ids || ids.includes(item.id)) && !item.readAt ? { ...item, readAt: stamp } : item,
      ),
    );
  }

  return (
    <div className="stack loose">
      <PageHead
        title="Notifications"
        actions={
          unread > 0 ? (
            <button
              type="button"
              className="btn"
              disabled={mark.pending}
              onClick={() => void onMarkRead()}
            >
              {mark.pending ? 'Marking…' : 'Mark all as read'}
            </button>
          ) : null
        }
      >
        Everything SafeCheck has told you — status changes on your reports, decisions, appeals and
        account security events.
      </PageHead>

      {error ? <Callout tone="danger">{error}</Callout> : null}
      {mark.error ? <Callout tone="danger">{mark.error}</Callout> : null}

      <Segmented<Filter>
        label="Filter notifications"
        value={filter}
        onChange={setFilter}
        options={[
          { value: null, label: 'All' },
          { value: 'unread', label: `Unread${unread > 0 ? ` (${unread})` : ''}` },
        ]}
      />

      <Card flush>
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty title={unreadOnly ? 'Nothing unread' : 'No notifications yet'}>
            {unreadOnly
              ? 'You are up to date.'
              : 'You will hear from us when something changes on a report you are part of.'}
          </Empty>
        ) : (
          <ul className="list">
            {items.map((item) => (
              <li key={item.id}>
                <NotificationRow
                  item={item}
                  pending={mark.pending}
                  onMarkRead={() => void onMarkRead([item.id])}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {cursor ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <button type="button" className="btn ghost" disabled={more.pending} onClick={() => void onLoadMore()}>
            {more.pending ? 'Loading…' : 'Load older'}
          </button>
        </div>
      ) : null}
      {more.error ? <Callout tone="danger">{more.error}</Callout> : null}
    </div>
  );
}

/** `href` is an in-app path from the API; anything not rooted at `/` is ignored. */
function safeHref(href: string | null): string | null {
  if (!href) return null;
  return href.startsWith('/') && !href.startsWith('//') ? href : null;
}

function NotificationRow({
  item,
  pending,
  onMarkRead,
}: {
  item: NotificationItem;
  pending: boolean;
  onMarkRead: () => void;
}) {
  const href = safeHref(item.href);
  const unread = !item.readAt;

  const body = (
    <div className="list-main">
      <span className="list-title">{item.title}</span>
      <span className="faint">{item.body}</span>
      <span className="faint">
        {notificationLabel(item.type)} · {formatDateTime(item.createdAt)}
      </span>
    </div>
  );

  return (
    <div className={`list-row${unread ? ' unread' : ''}`}>
      {href ? (
        <Link href={href} className="list-link" onClick={unread ? onMarkRead : undefined}>
          {body}
        </Link>
      ) : (
        body
      )}
      <div className="row">
        {unread ? (
          <>
            <button type="button" className="btn ghost small" disabled={pending} onClick={onMarkRead}>
              Mark read
            </button>
            <Badge tone="open">New</Badge>
          </>
        ) : null}
      </div>
    </div>
  );
}
