'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CASE_PRIORITIES, CASE_STATES, type CasePriority, type CaseState } from '@safecheck/shared';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { useLoader } from '@/lib/hooks';
import {
  caseStateLabel,
  categoryLabel,
  formatDate,
  priorityLabel,
  relativeDays,
  reportStatusLabel,
} from '@/lib/labels';
import type { CaseSummaryDto } from '@/lib/api-types';
import { Badge, Callout, Card, Empty, Loading, PageHead, Segmented } from '@/components/ui';

/**
 * The moderation queue.
 *
 * Ordering comes from the API — grave first, then priority, then age — and this
 * page does not re-sort it. What it adds is the two signals a moderator needs
 * before opening anything: whether a case is grave, and whether it is past its
 * SLA. `overdue` is a reporting signal only; nothing about it changes how a case
 * must be handled, and it never shortens a review.
 */
export default function ModerationQueuePage() {
  const { status } = useRequireAuth('moderator');
  const [state, setState] = useState<CaseState | null>(null);
  const [priority, setPriority] = useState<CasePriority | null>(null);
  const [mine, setMine] = useState(false);

  const key = `queue:${state ?? 'all'}:${priority ?? 'all'}:${mine}`;
  const loader = useLoader(key, () =>
    api.listQueue({
      state: state ?? undefined,
      priority: priority ?? undefined,
      assignedToMe: mine,
      limit: 50,
    }),
  );

  const cases = loader.data ?? [];
  const summary = useMemo(
    () => ({
      grave: cases.filter((item) => item.grave).length,
      overdue: cases.filter((item) => item.overdue).length,
      unassigned: cases.filter((item) => item.state === 'unassigned').length,
    }),
    [cases],
  );

  if (status !== 'authenticated') return null;

  return (
    <div className="stack loose">
      <PageHead title="Case queue">
        Every submitted report opens a case, and every case has a human owner. Nothing here is decided
        automatically.
      </PageHead>

      {loader.error ? <Callout tone="danger">{loader.error}</Callout> : null}

      {cases.length > 0 ? (
        <div className="row">
          <span className="muted">
            {cases.length} case{cases.length === 1 ? '' : 's'}
          </span>
          {summary.unassigned > 0 ? <Badge tone="open">{summary.unassigned} unassigned</Badge> : null}
          {summary.grave > 0 ? <Badge tone="grave">{summary.grave} grave</Badge> : null}
          {summary.overdue > 0 ? <Badge tone="alert">{summary.overdue} past SLA</Badge> : null}
        </div>
      ) : null}

      <div className="stack tight">
        <Segmented<CaseState>
          label="Filter by case state"
          value={state}
          onChange={setState}
          options={[
            { value: null, label: 'Any state' },
            ...CASE_STATES.map((value) => ({ value, label: caseStateLabel(value) })),
          ]}
        />
        <Segmented<CasePriority>
          label="Filter by priority"
          value={priority}
          onChange={setPriority}
          options={[
            { value: null, label: 'Any priority' },
            ...CASE_PRIORITIES.map((value) => ({ value, label: priorityLabel(value) })),
          ]}
        />
        <label className="check">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          <span>Only cases assigned to me</span>
        </label>
      </div>

      <Card flush>
        {loader.loading && !loader.data ? (
          <Loading label="Loading queue…" />
        ) : cases.length === 0 ? (
          <Empty title="Nothing matches these filters">
            {state || priority || mine
              ? 'Try widening the filters.'
              : 'The queue is clear. Newly submitted reports will appear here.'}
          </Empty>
        ) : (
          <ul className="list">
            {cases.map((item) => (
              <li key={item.id}>
                <CaseRow item={item} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function CaseRow({ item }: { item: CaseSummaryDto }) {
  return (
    <Link href={`/moderation/cases/${item.id}`} className="list-row">
      <div className="list-main">
        <span className="list-title">
          {categoryLabel(item.category)}
          {item.grave ? <span className="badge grave" style={{ marginLeft: 8 }}>Grave</span> : null}
        </span>
        <span className="faint">
          {caseStateLabel(item.state)} · report {reportStatusLabel(item.reportStatus).toLowerCase()} ·
          opened {formatDate(item.createdAt)}
          {item.assignedTo ? '' : ' · unassigned'}
        </span>
        {item.slaDueAt ? (
          <span className={item.overdue ? 'err' : 'faint'}>
            {item.overdue ? 'Past SLA' : 'Due'} {relativeDays(item.slaDueAt)}
          </span>
        ) : null}
      </div>
      <Badge tone={item.priority === 'urgent' ? 'alert' : item.priority === 'high' ? 'active' : 'draft'}>
        {priorityLabel(item.priority)}
      </Badge>
    </Link>
  );
}
