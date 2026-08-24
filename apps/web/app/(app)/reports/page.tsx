'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useLoader } from '@/lib/hooks';
import { categoryLabel, formatDate, reportStatusLabel, reportStatusTone } from '@/lib/labels';
import type { ReportSummaryDto } from '@/lib/api-types';
import { Badge, Callout, Card, Empty, Loading, PageHead, Segmented } from '@/components/ui';

/**
 * The reporter's own reports.
 *
 * Grouping is done here rather than in the request because the API filters on one
 * exact status, and "in progress" spans four of them. Fetching the page once and
 * grouping locally also means switching tabs costs nothing.
 */

type Group = 'drafts' | 'progress' | 'decided' | 'withdrawn';

const GROUPS: Record<Group, readonly string[]> = {
  drafts: ['draft'],
  progress: ['submitted', 'triage', 'under_review', 'awaiting_evidence'],
  decided: ['decided'],
  withdrawn: ['withdrawn'],
};

export default function ReportsPage() {
  const [group, setGroup] = useState<Group | null>(null);
  const reports = useLoader('reports', () => api.listReports({ limit: 50 }));

  const visible = useMemo(() => {
    if (!reports.data) return [];
    if (!group) return reports.data;
    return reports.data.filter((report) => GROUPS[group].includes(report.status));
  }, [reports.data, group]);

  const counts = useMemo(() => {
    const all = reports.data ?? [];
    return {
      drafts: all.filter((r) => GROUPS.drafts.includes(r.status)).length,
      progress: all.filter((r) => GROUPS.progress.includes(r.status)).length,
      decided: all.filter((r) => GROUPS.decided.includes(r.status)).length,
      withdrawn: all.filter((r) => GROUPS.withdrawn.includes(r.status)).length,
    };
  }, [reports.data]);

  return (
    <div className="stack loose">
      <PageHead
        title="My reports"
        actions={
          <Link href="/reports/new" className="btn primary">
            New report
          </Link>
        }
      >
        Everything you have filed. A report is only visible to you and to the moderators reviewing
        it — never to the person it concerns until a decision is issued.
      </PageHead>

      {reports.error ? <Callout tone="danger">{reports.error}</Callout> : null}

      <Segmented<Group>
        label="Filter reports"
        value={group}
        onChange={setGroup}
        options={[
          { value: null, label: `All${reports.data ? ` (${reports.data.length})` : ''}` },
          { value: 'progress', label: `In progress (${counts.progress})` },
          { value: 'drafts', label: `Drafts (${counts.drafts})` },
          { value: 'decided', label: `Decided (${counts.decided})` },
          { value: 'withdrawn', label: `Withdrawn (${counts.withdrawn})` },
        ]}
      />

      <Card flush>
        {reports.loading ? (
          <Loading />
        ) : visible.length === 0 ? (
          <Empty title={group ? 'Nothing in this group' : 'You have not filed any reports'}>
            {group ? (
              'Try another filter.'
            ) : (
              <>
                When you do, you can save a draft first and attach evidence before submitting.{' '}
                <Link href="/reports/new">Start one</Link>.
              </>
            )}
          </Empty>
        ) : (
          <ul className="list">
            {visible.map((report) => (
              <li key={report.id}>
                <ReportRow report={report} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ReportRow({ report }: { report: ReportSummaryDto }) {
  return (
    <Link href={`/reports/${report.id}`} className="list-row">
      <div className="list-main">
        <span className="list-title">{categoryLabel(report.category)}</span>
        <span className="faint">
          About {report.subjectLabel} · filed {formatDate(report.createdAt)}
          {report.evidenceCount > 0
            ? ` · ${report.evidenceCount} file${report.evidenceCount === 1 ? '' : 's'}`
            : ''}
        </span>
      </div>
      <Badge tone={reportStatusTone(report.status)}>{reportStatusLabel(report.status)}</Badge>
    </Link>
  );
}
