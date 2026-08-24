'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ALLOWED_EVIDENCE_MIME,
  MAX_EVIDENCE_BYTES,
  appealSchemas,
  reportSchemas,
} from '@safecheck/shared';
import { api } from '@/lib/api';
import { useAction, useLoader, validate, type FieldErrors } from '@/lib/hooks';
import {
  appealPartyLabel,
  appealStateLabel,
  categoryLabel,
  formatBytes,
  formatDate,
  formatDateTime,
  outcomeLabel,
  outcomeMeaning,
  outcomeTone,
  relativeDays,
  reportStatusLabel,
  reportStatusMeaning,
  reportStatusTone,
  scanStatusLabel,
  toInstant,
  toLocalInput,
} from '@/lib/labels';
import type { EvidenceDto, ReportDetailDto } from '@/lib/api-types';
import {
  Badge,
  Callout,
  Card,
  CharCount,
  Empty,
  Facts,
  Field,
  FormError,
  Loading,
  PageHead,
  SubmitButton,
} from '@/components/ui';

/**
 * One report, from the reporter's side.
 *
 * The API admits the reporter or a moderator here and answers 404 to everyone
 * else, including the person the report is about — so this page is written for
 * the reporter, and the appeal it files is always `party: 'reporter'`.
 *
 * What the page can do depends on status, and the rules come from the service
 * rather than from taste: a draft is editable and submittable, anything submitted
 * is frozen (the narrative has become evidence), a decided report cannot be
 * withdrawn but can be appealed, and evidence can be attached at any point before
 * a decision.
 */
export default function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const loader = useLoader(`report:${id}`, () => api.getReport(id));

  if (loader.loading && !loader.data) return <Loading label="Loading report…" />;

  if (loader.error || !loader.data) {
    return (
      <div className="stack loose">
        <PageHead title="Report" />
        <Callout tone="danger" title="This report could not be opened">
          {loader.error ?? 'It may have been removed, or it may not be yours to see.'}
        </Callout>
        <Link href="/reports" className="btn ghost">
          Back to my reports
        </Link>
      </div>
    );
  }

  const { report, evidence } = loader.data;
  const isDraft = report.status === 'draft';
  const isClosed = report.status === 'withdrawn';
  const canWithdraw = !isClosed && report.status !== 'decided';

  return (
    <div className="stack loose">
      <PageHead
        title={categoryLabel(report.category)}
        actions={<Badge tone={reportStatusTone(report.status)}>{reportStatusLabel(report.status)}</Badge>}
      >
        Filed {formatDate(report.createdAt)} · about {report.subjectLabel}
      </PageHead>

      {reportStatusMeaning(report.status) ? (
        <Callout tone={isDraft ? 'warn' : isClosed ? 'neutral' : 'info'}>
          {reportStatusMeaning(report.status)}
        </Callout>
      ) : null}

      {report.decision ? <DecisionPanel report={report} onChanged={loader.reload} /> : null}

      <Card title="Details">
        <Facts
          items={[
            ['Category', categoryLabel(report.category)],
            ['About', report.subjectLabel],
            ['When it happened', report.incidentAt ? formatDateTime(report.incidentAt) : null],
            ['Where', report.location ?? null],
            ['Filed', formatDateTime(report.createdAt)],
            ['Last updated', formatDateTime(report.updatedAt)],
          ]}
        />
      </Card>

      {isDraft ? (
        <DraftEditor report={report} onChanged={loader.reload} />
      ) : (
        <Card title="Your account of what happened">
          <p className="prose">{report.description}</p>
        </Card>
      )}

      <EvidencePanel report={report} evidence={evidence} onChanged={loader.reload} />

      {report.decision ? <AppealsPanel reportId={report.id} /> : null}

      {canWithdraw ? <WithdrawPanel report={report} onChanged={loader.reload} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------- decision */

function DecisionPanel({
  report,
  onChanged,
}: {
  report: ReportDetailDto;
  onChanged: () => void;
}) {
  const decision = report.decision;
  const [open, setOpen] = useState(false);
  if (!decision) return null;

  return (
    <div className="stack">
      <Card
        title="Decision"
        actions={<Badge tone={outcomeTone(decision.outcome)}>{outcomeLabel(decision.outcome)}</Badge>}
      >
        <div className="stack">
          {/*
            Spelled out rather than left to inference. "Not upheld" is not a
            finding of innocence and "insufficient evidence" is not a finding that
            nothing happened, and a party reading their own outcome should not have
            to guess which one they got.
          */}
          <p className="muted">{outcomeMeaning(decision.outcome)}</p>

          <div className="stack tight">
            <span className="eyebrow">Moderator&rsquo;s reasoning</span>
            <p className="prose">{decision.rationale}</p>
          </div>

          <Facts
            items={[
              ['Issued', formatDateTime(decision.issuedAt)],
              [
                'Appeal window closes',
                `${formatDate(decision.appealWindowEndsAt)} (${relativeDays(decision.appealWindowEndsAt)})`,
              ],
            ]}
          />

          {decision.canAppeal ? (
            <div className="row between">
              <span className="muted">
                You can ask for this to be reviewed again while the window is open.
              </span>
              <button type="button" className="btn" onClick={() => setOpen((v) => !v)}>
                {open ? 'Cancel appeal' : 'Appeal this decision'}
              </button>
            </div>
          ) : (
            <Callout tone="neutral">
              This decision can no longer be appealed — either the window has closed or an appeal has
              already been filed.
            </Callout>
          )}
        </div>
      </Card>

      {open && decision.canAppeal ? (
        <AppealForm
          reportId={report.id}
          onDone={() => {
            setOpen(false);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function AppealForm({ reportId, onDone }: { reportId: string; onDone: () => void }) {
  const action = useAction();
  const [grounds, setGrounds] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    // Always 'reporter': the API refuses this page to the subject, and filing "as
    // the subject" from here would be a claim the server rightly rejects.
    const parsed = validate(appealSchemas.fileAppealInput, { party: 'reporter', grounds });
    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      action.fail(parsed.formErrors[0] ?? 'Explain the grounds for your appeal.');
      return;
    }
    setLocal({});

    const appeal = await action.run(() => api.fileAppeal(reportId, parsed.data));
    if (appeal) onDone();
  }

  return (
    <Card title="Appeal this decision">
      <form className="stack" onSubmit={onSubmit} noValidate>
        <FormError error={action.error} />
        <p className="muted">
          An appeal is reviewed by a moderator who was not involved in the decision. Say what you
          think was missed or got wrong — new evidence, a misread fact, a process problem.
        </p>

        <Field
          label="Grounds for appeal"
          htmlFor="grounds"
          error={local.grounds ?? action.fieldErrors.grounds}
          hint="Between 30 and 4000 characters."
          aside={<CharCount value={grounds} min={30} max={4000} />}
        >
          <textarea
            id="grounds"
            rows={7}
            value={grounds}
            onChange={(e) => setGrounds(e.target.value)}
          />
        </Field>

        <div className="row end">
          <SubmitButton pending={action.pending}>File appeal</SubmitButton>
        </div>
      </form>
    </Card>
  );
}

function AppealsPanel({ reportId }: { reportId: string }) {
  const loader = useLoader(`appeals:${reportId}`, () => api.listReportAppeals(reportId));
  const action = useAction();

  async function onWithdraw(appealId: string) {
    const done = await action.run(() => api.withdrawAppeal(appealId));
    if (done) loader.reload();
  }

  if (loader.loading && !loader.data) return null;
  if (!loader.data || loader.data.length === 0) return null;

  return (
    <Card title="Appeals" flush>
      <div style={{ padding: '0 18px 18px' }}>
        <FormError error={action.error} />
      </div>
      <ul className="list">
        {loader.data.map((appeal) => {
          const live = appeal.state === 'filed' || appeal.state === 'under_review';
          return (
            <li key={appeal.id}>
              <div className="list-row">
                <div className="list-main">
                  <span className="list-title">{appealPartyLabel(appeal.party)} appealed</span>
                  <span className="faint">
                    Filed {formatDate(appeal.filedAt)}
                    {appeal.resolvedAt ? ` · resolved ${formatDate(appeal.resolvedAt)}` : ''}
                  </span>
                </div>
                <div className="row">
                  {/* Only your own appeal can be withdrawn, and only while it is live. */}
                  {live && appeal.party === 'reporter' ? (
                    <button
                      type="button"
                      className="btn ghost small"
                      disabled={action.pending}
                      onClick={() => void onWithdraw(appeal.id)}
                    >
                      Withdraw
                    </button>
                  ) : null}
                  <Badge tone={live ? 'active' : 'closed'}>{appealStateLabel(appeal.state)}</Badge>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/* ---------------------------------------------------------------------- draft */

function DraftEditor({ report, onChanged }: { report: ReportDetailDto; onChanged: () => void }) {
  const save = useAction();
  const submit = useAction();
  const [description, setDescription] = useState(report.description);
  const [incidentAt, setIncidentAt] = useState(toLocalInput(report.incidentAt));
  const [location, setLocation] = useState(report.location ?? '');
  const [local, setLocal] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);

  const fieldError = (name: string) => local[name] ?? save.fieldErrors[name];

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    setSaved(false);
    const parsed = validate(reportSchemas.updateReportDraftInput, {
      description,
      incidentAt: toInstant(incidentAt),
      location: location.trim() || undefined,
    });
    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      save.fail(parsed.formErrors[0] ?? 'Check the fields below.');
      return;
    }
    setLocal({});

    const updated = await save.run(() => api.updateDraft(report.id, parsed.data));
    if (updated) {
      setSaved(true);
      onChanged();
    }
  }

  async function onSubmitReport() {
    const done = await submit.run(() => api.submitReport(report.id));
    if (done) onChanged();
  }

  return (
    <div className="stack">
      <Card title="Edit your draft">
        <form className="stack" onSubmit={onSave} noValidate>
          <FormError error={save.error} />
          {saved ? <Callout tone="success">Draft saved.</Callout> : null}

          <Field
            label="Your account of what happened"
            htmlFor="description"
            error={fieldError('description')}
            hint="Between 40 and 8000 characters."
            aside={<CharCount value={description} min={40} max={8000} />}
          >
            <textarea
              id="description"
              rows={11}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <div className="grid">
            <Field label="When did it happen?" htmlFor="incidentAt" error={fieldError('incidentAt')}>
              <input
                id="incidentAt"
                type="datetime-local"
                value={incidentAt}
                onChange={(e) => setIncidentAt(e.target.value)}
              />
            </Field>
            <Field label="Where did it happen?" htmlFor="location" error={fieldError('location')}>
              <input
                id="location"
                type="text"
                maxLength={200}
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </Field>
          </div>

          <div className="row end">
            <SubmitButton pending={save.pending} variant="secondary">
              Save draft
            </SubmitButton>
          </div>
        </form>
      </Card>

      <Card title="Submit for review">
        <div className="stack">
          <FormError error={submit.error} />
          {/*
            Stated before the button, not after: the narrative becomes part of the
            record on submission and the service refuses edits from that point.
          */}
          <Callout tone="warn" title="Once submitted, the description is fixed">
            A moderator will read this account, so it cannot be edited afterwards. You can still
            attach evidence, and you can withdraw the report while it is under review.
          </Callout>
          <div className="row end">
            <button
              type="button"
              className="btn primary"
              disabled={submit.pending}
              onClick={() => void onSubmitReport()}
            >
              {submit.pending ? 'Submitting…' : 'Submit for review'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------- evidence */

function EvidencePanel({
  report,
  evidence,
  onChanged,
}: {
  report: ReportDetailDto;
  evidence: EvidenceDto[];
  onChanged: () => void;
}) {
  const upload = useAction();
  const grab = useAction();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const closed = report.status === 'withdrawn' || report.status === 'decided';

  async function onUpload(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      upload.fail('Choose a file first.');
      return;
    }
    // Checked here as well as on the server so a 50 MB upload is not spent
    // discovering the limit.
    if (file.size > MAX_EVIDENCE_BYTES) {
      upload.fail(`That file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_EVIDENCE_BYTES)}.`);
      return;
    }
    if (file.type && !(ALLOWED_EVIDENCE_MIME as readonly string[]).includes(file.type)) {
      upload.fail('That file type is not accepted. Images, PDFs, plain text and audio only.');
      return;
    }

    const done = await upload.run(() => api.uploadEvidence(report.id, file, caption.trim()));
    if (done) {
      setFile(null);
      setCaption('');
      if (inputRef.current) inputRef.current.value = '';
      onChanged();
    }
  }

  /**
   * Evidence is fetched through the authenticated client and handed to the browser
   * as a blob. It is never an `<a href>` or an `<img src>`: the endpoint needs a
   * bearer token, and it answers with `Content-Disposition: attachment` and a
   * locked CSP so the bytes can never be rendered inside this origin.
   */
  async function onDownload(item: EvidenceDto) {
    setBusyId(item.id);
    const result = await grab.run(() => api.evidenceBlob(item.id));
    setBusyId(null);
    if (!result) return;

    const url = URL.createObjectURL(result.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Card title={`Evidence (${evidence.length})`}>
      <div className="stack">
        <FormError error={grab.error} />

        {evidence.length === 0 ? (
          <Empty title="Nothing attached yet">
            Screenshots, messages, documents or recordings all help a moderator understand what
            happened.
          </Empty>
        ) : (
          <ul className="list">
            {evidence.map((item) => (
              <li key={item.id}>
                <div className="list-row">
                  <div className="list-main">
                    <span className="list-title">{item.filename}</span>
                    <span className="faint">
                      {formatBytes(item.sizeBytes)} · added {formatDate(item.createdAt)}
                      {item.caption ? ` · ${item.caption}` : ''}
                    </span>
                  </div>
                  <div className="row">
                    {item.releasable ? (
                      <button
                        type="button"
                        className="btn ghost small"
                        disabled={busyId === item.id}
                        onClick={() => void onDownload(item)}
                      >
                        {busyId === item.id ? 'Fetching…' : 'Download'}
                      </button>
                    ) : null}
                    <Badge tone={item.releasable ? 'done' : 'draft'}>
                      {scanStatusLabel(item.scanStatus, item.releasable)}
                    </Badge>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {closed ? (
          <p className="faint">
            This report is closed, so no further evidence can be attached.
          </p>
        ) : (
          <>
            <hr className="rule" />
            <form className="stack" onSubmit={onUpload} noValidate>
              <FormError error={upload.error} />

              <Field
                label="Attach a file"
                htmlFor="file"
                hint={`Images, PDFs, plain text or audio. Up to ${formatBytes(MAX_EVIDENCE_BYTES)}. Files are scanned before a moderator can open them.`}
              >
                <input
                  id="file"
                  ref={inputRef}
                  type="file"
                  accept={ALLOWED_EVIDENCE_MIME.join(',')}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </Field>

              <Field
                label="What does it show?"
                htmlFor="caption"
                hint="Optional, but it saves a moderator guessing."
              >
                <input
                  id="caption"
                  type="text"
                  maxLength={300}
                  placeholder="e.g. Messages received on 3 August"
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                />
              </Field>

              <div className="row end">
                <SubmitButton pending={upload.pending} variant="secondary" disabled={!file}>
                  Attach evidence
                </SubmitButton>
              </div>
            </form>
          </>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------- withdraw */

function WithdrawPanel({ report, onChanged }: { report: ReportDetailDto; onChanged: () => void }) {
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = validate(reportSchemas.withdrawReportInput, { reason });
    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      action.fail(parsed.formErrors[0] ?? 'Give a short reason.');
      return;
    }
    setLocal({});

    const done = await action.run(() => api.withdrawReport(report.id, parsed.data.reason));
    if (done) {
      setOpen(false);
      onChanged();
    }
  }

  return (
    <Card title="Withdraw this report">
      {open ? (
        <form className="stack" onSubmit={onSubmit} noValidate>
          <FormError error={action.error} />
          <Callout tone="warn">
            Withdrawing stops the review. The report and anything you attached stay on the record for
            audit, but no decision will be made and nothing will ever be published from it.
          </Callout>

          <Field
            label="Why are you withdrawing it?"
            htmlFor="reason"
            error={local.reason ?? action.fieldErrors.reason}
            hint="Between 5 and 1000 characters. Only moderators see this."
            aside={<CharCount value={reason} min={5} max={1000} />}
          >
            <textarea id="reason" rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>

          <div className="row between">
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
              Keep the report
            </button>
            <SubmitButton pending={action.pending} variant="danger">
              Withdraw report
            </SubmitButton>
          </div>
        </form>
      ) : (
        <div className="row between">
          <span className="muted">
            You can stop the review at any point before a decision is issued.
          </span>
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            Withdraw…
          </button>
        </div>
      )}
    </Card>
  );
}
