'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  CASE_PRIORITIES,
  DECISION_OUTCOMES,
  moderationSchemas,
  type CasePriority,
  type DecisionOutcome,
} from '@safecheck/shared';
import { api } from '@/lib/api';
import { useAuth, useRequireAuth } from '@/lib/auth';
import { useAction, useLoader, validate, type FieldErrors } from '@/lib/hooks';
import {
  caseStateLabel,
  categoryLabel,
  formatDate,
  formatDateTime,
  outcomeLabel,
  priorityLabel,
  relativeDays,
  reportStatusLabel,
  scanStatusLabel,
} from '@/lib/labels';
import type { CaseDetailDto, DisclosureDto } from '@/lib/api-types';
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
 * One case, from the moderator's side.
 *
 * The page is arranged around the distinction the whole product rests on:
 * DECIDING IS NOT PUBLISHING. Issuing a decision resolves the report and tells the
 * subject; it makes nothing searchable. Publication is a separate act, on a
 * separate panel, with its own preconditions — and even a published record is
 * re-checked by the disclosure gate on every search. The panel shows that gate's
 * live verdict rather than just the flag, because a moderator shown only the flag
 * will assume the two are the same thing.
 */

const WORKABLE_STATES = ['assigned', 'investigating', 'awaiting_decision', 'closed'] as const;
type WorkableState = (typeof WORKABLE_STATES)[number];

export default function CaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { status } = useRequireAuth('moderator');
  const loader = useLoader(`case:${id}`, () => api.getCase(id));

  if (status !== 'authenticated') return null;
  if (loader.loading && !loader.data) return <Loading label="Loading case…" />;

  if (loader.error || !loader.data) {
    return (
      <div className="stack loose">
        <PageHead title="Case" />
        <Callout tone="danger" title="This case could not be opened">
          {loader.error ?? 'It may have been removed.'}
        </Callout>
        <Link href="/moderation" className="btn ghost">
          Back to the queue
        </Link>
      </div>
    );
  }

  const kase = loader.data;

  return (
    <div className="stack loose">
      <PageHead
        title={categoryLabel(kase.category)}
        actions={
          <div className="row">
            {kase.grave ? <Badge tone="grave">Grave category</Badge> : null}
            <Badge tone={kase.state === 'closed' ? 'closed' : 'active'}>
              {caseStateLabel(kase.state)}
            </Badge>
          </div>
        }
      >
        Case opened {formatDate(kase.createdAt)} · report is{' '}
        {reportStatusLabel(kase.report.status).toLowerCase()}
      </PageHead>

      <CaseControls kase={kase} onChanged={loader.set} />

      <Card title="The allegation">
        <div className="stack">
          <Facts
            items={[
              ['Category', categoryLabel(kase.report.category)],
              ['Subject', kase.report.subjectLabel],
              [
                'Subject notified',
                kase.report.subjectNotifiedAt
                  ? formatDateTime(kase.report.subjectNotifiedAt)
                  : 'Not yet',
              ],
              ['When it happened', kase.report.incidentAt ? formatDateTime(kase.report.incidentAt) : null],
              ['Where', kase.report.location ?? null],
              ['SLA', kase.slaDueAt ? `${formatDate(kase.slaDueAt)} (${relativeDays(kase.slaDueAt)})` : null],
            ]}
          />
          {/*
            A label, never an identifier. The API holds the subject's email and
            phone as keyed hashes and does not send either — so there is nothing
            here to copy out, by design.
          */}
          <p className="faint">
            &ldquo;Subject&rdquo; is a display label. SafeCheck stores the identifier as a keyed hash
            and cannot show it to anyone, including moderators.
          </p>
          <hr className="rule" />
          <div className="stack tight">
            <span className="eyebrow">Reporter&rsquo;s account</span>
            <p className="prose">{kase.report.description}</p>
          </div>
        </div>
      </Card>

      <EvidenceList kase={kase} />
      <NotesPanel kase={kase} onChanged={loader.set} />
      <DecisionSection kase={kase} onChanged={loader.reload} />
    </div>
  );
}

/* ------------------------------------------------------------------- controls */

function CaseControls({
  kase,
  onChanged,
}: {
  kase: CaseDetailDto;
  onChanged: (next: CaseDetailDto) => void;
}) {
  const { user } = useAuth();
  const action = useAction();
  const mine = Boolean(user && kase.assignedTo === user.id);

  async function run(fn: () => Promise<CaseDetailDto>) {
    const next = await action.run(fn);
    if (next) onChanged(next);
  }

  return (
    <Card title="Working this case">
      <div className="stack">
        <FormError error={action.error} />

        <div className="row between">
          <span className="muted">
            {kase.assignedTo
              ? mine
                ? 'Assigned to you.'
                : 'Assigned to another moderator. Only they or an admin can act on it.'
              : 'Unassigned. Take it before adding notes or issuing a decision.'}
          </span>
          {!mine ? (
            <button
              type="button"
              className="btn primary"
              disabled={action.pending}
              onClick={() => void run(() => api.assignCase(kase.id))}
            >
              {kase.assignedTo ? 'Reassign to me' : 'Assign to me'}
            </button>
          ) : null}
        </div>

        <hr className="rule" />

        <div className="field">
          <span className="field-label">Case state</span>
          <div className="btn-group">
            {WORKABLE_STATES.map((state) => (
              <button
                key={state}
                type="button"
                className={`btn small${kase.state === state ? ' primary' : ''}`}
                disabled={action.pending || kase.state === state}
                onClick={() => void run(() => api.setCaseState(kase.id, state as WorkableState))}
              >
                {caseStateLabel(state)}
              </button>
            ))}
          </div>
          <span className="hint">
            Closing a case here does not decide the report. Issue a decision below for that.
          </span>
        </div>

        <div className="field">
          <span className="field-label">Priority</span>
          <div className="btn-group">
            {CASE_PRIORITIES.map((priority) => (
              <button
                key={priority}
                type="button"
                className={`btn small${kase.priority === priority ? ' primary' : ''}`}
                disabled={action.pending || kase.priority === priority}
                onClick={() => void run(() => api.setCasePriority(kase.id, priority as CasePriority))}
              >
                {priorityLabel(priority)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------- evidence */

function EvidenceList({ kase }: { kase: CaseDetailDto }) {
  const grab = useAction();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function onDownload(evidenceId: string) {
    setBusyId(evidenceId);
    const result = await grab.run(() => api.evidenceBlob(evidenceId));
    setBusyId(null);
    if (!result) return;

    // Downloaded, never rendered: the endpoint answers with
    // `Content-Disposition: attachment` and a locked CSP so hostile content cannot
    // execute in this origin.
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
    <Card title={`Evidence (${kase.evidence.length})`}>
      <div className="stack">
        <FormError error={grab.error} />
        {kase.evidence.length === 0 ? (
          <Empty title="No evidence attached">
            The reporter may still add files while the report is open.
          </Empty>
        ) : (
          <ul className="list">
            {kase.evidence.map((item) => (
              <li key={item.id}>
                <div className="list-row">
                  <div className="list-main">
                    <span className="list-title">{item.filename}</span>
                    <span className="faint">{item.kind}</span>
                  </div>
                  <div className="row">
                    {item.releasable ? (
                      <button
                        type="button"
                        className="btn ghost small"
                        disabled={busyId === item.id}
                        onClick={() => void onDownload(item.id)}
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
        <p className="faint">
          Every download is recorded against your account. Files that have not passed scanning cannot
          be fetched at all.
        </p>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------------- notes */

function NotesPanel({
  kase,
  onChanged,
}: {
  kase: CaseDetailDto;
  onChanged: (next: CaseDetailDto) => void;
}) {
  const action = useAction();
  const [body, setBody] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = validate(moderationSchemas.addCaseNoteInput, { body, visibility: 'internal' });
    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      action.fail(parsed.formErrors[0] ?? 'Write something first.');
      return;
    }
    setLocal({});

    const next = await action.run(() => api.addCaseNote(kase.id, parsed.data.body));
    if (next) {
      setBody('');
      onChanged(next);
    }
  }

  return (
    <Card title={`Case notes (${kase.notes.length})`}>
      <div className="stack">
        {kase.notes.length === 0 ? (
          <p className="muted">No notes yet.</p>
        ) : (
          <ul className="timeline">
            {kase.notes.map((note) => (
              <li key={note.id}>
                <span className="faint">{formatDateTime(note.createdAt)}</span>
                <p className="prose">{note.body}</p>
              </li>
            ))}
          </ul>
        )}

        <hr className="rule" />

        <form className="stack" onSubmit={onSubmit} noValidate>
          <FormError error={action.error} />
          <Field
            label="Add a note"
            htmlFor="note"
            error={local.body ?? action.fieldErrors.body}
            hint="Internal to moderators. Neither party ever sees this, but it is part of the audit record."
            aside={<CharCount value={body} max={4000} />}
          >
            <textarea id="note" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          <div className="row end">
            <SubmitButton pending={action.pending} variant="secondary" disabled={!body.trim()}>
              Add note
            </SubmitButton>
          </div>
        </form>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------- decision */

function DecisionSection({ kase, onChanged }: { kase: CaseDetailDto; onChanged: () => void }) {
  if (!kase.decision) {
    if (kase.report.status === 'withdrawn') {
      return (
        <Card title="Decision">
          <Callout tone="neutral">
            The reporter withdrew this report, so it cannot be decided. The record stays for audit.
          </Callout>
        </Card>
      );
    }
    return <IssueDecisionForm kase={kase} onChanged={onChanged} />;
  }
  return <DecisionRecord kase={kase} onChanged={onChanged} />;
}

function IssueDecisionForm({ kase, onChanged }: { kase: CaseDetailDto; onChanged: () => void }) {
  const action = useAction();
  const [outcome, setOutcome] = useState<DecisionOutcome | ''>('');
  const [rationale, setRationale] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [local, setLocal] = useState<FieldErrors>({});

  const fieldError = (name: string) => local[name] ?? action.fieldErrors[name];

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = validate(moderationSchemas.issueDecisionInput, {
      outcome: outcome || undefined,
      rationale,
      acknowledgeSubjectNotification: acknowledge,
    });
    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      action.fail(parsed.formErrors[0] ?? 'Check the fields below.');
      return;
    }
    setLocal({});

    const decision = await action.run(() => api.issueDecision(kase.id, parsed.data));
    if (decision) onChanged();
  }

  return (
    <Card title="Issue a decision">
      <form className="stack" onSubmit={onSubmit} noValidate>
        <FormError error={action.error} />

        <Callout tone="info" title="This resolves the report. It does not publish anything.">
          Issuing a decision closes the case, tells the subject that a decision concerns them, and
          opens the appeal window. Nothing becomes searchable as a result — publication is a separate
          decision, reviewed on this page once the appeal window has run.
        </Callout>

        <Field label="Outcome" htmlFor="outcome" error={fieldError('outcome')}>
          <select
            id="outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as DecisionOutcome)}
          >
            <option value="">Choose an outcome…</option>
            {DECISION_OUTCOMES.map((value) => (
              <option key={value} value={value}>
                {outcomeLabel(value)}
              </option>
            ))}
          </select>
        </Field>

        {outcome === 'upheld' ? (
          <Callout tone="warn">
            Upheld is the only outcome that can ever appear in search. It still will not, unless a
            second review clears it for publication and the disclosure gate passes at query time.
          </Callout>
        ) : null}

        <Field
          label="Rationale"
          htmlFor="rationale"
          error={fieldError('rationale')}
          hint="Between 20 and 4000 characters. Both parties will read this, so write it for them and not for the file."
          aside={<CharCount value={rationale} min={20} max={4000} />}
        >
          <textarea
            id="rationale"
            rows={8}
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
          />
        </Field>

        <label className="check">
          <input
            type="checkbox"
            checked={acknowledge}
            onChange={(e) => setAcknowledge(e.target.checked)}
          />
          <span>
            I understand the person this report concerns will be notified that a decision has been
            made about them.
          </span>
        </label>
        {fieldError('acknowledgeSubjectNotification') ? (
          <span className="err">{fieldError('acknowledgeSubjectNotification')?.[0]}</span>
        ) : null}

        <div className="row end">
          <SubmitButton pending={action.pending}>Issue decision</SubmitButton>
        </div>
      </form>
    </Card>
  );
}

function DecisionRecord({ kase, onChanged }: { kase: CaseDetailDto; onChanged: () => void }) {
  const decision = kase.decision;
  if (!decision) return null;

  return (
    <div className="stack">
      <Card
        title="Decision"
        actions={
          <div className="row">
            {decision.vacatedAt ? <Badge tone="alert">Vacated on appeal</Badge> : null}
            <Badge tone={decision.publishable ? 'done' : 'draft'}>
              {decision.publishable ? 'Cleared for publication' : 'Not cleared'}
            </Badge>
          </div>
        }
      >
        <div className="stack">
          <Facts
            items={[
              ['Outcome', outcomeLabel(decision.outcome)],
              ['Issued', formatDateTime(decision.issuedAt)],
              [
                'Appeal window closes',
                `${formatDate(decision.appealWindowEndsAt)} (${relativeDays(decision.appealWindowEndsAt)})`,
              ],
              ['Vacated', decision.vacatedAt ? formatDateTime(decision.vacatedAt) : null],
            ]}
          />
          <div className="stack tight">
            <span className="eyebrow">Rationale</span>
            <p className="prose">{decision.rationale}</p>
          </div>
        </div>
      </Card>

      <PublicationPanel kase={kase} onChanged={onChanged} />
    </div>
  );
}

/**
 * The publication review.
 *
 * The flag and the gate are shown side by side on purpose. `publishable` is a
 * moderator's clearance; `disclosure` is what search would actually do right now.
 * They disagree routinely — a cleared record with a pending appeal discloses
 * nothing — and a moderator who cannot see that difference will believe they have
 * published something they have not, or vice versa.
 */
function PublicationPanel({ kase, onChanged }: { kase: CaseDetailDto; onChanged: () => void }) {
  const decision = kase.decision;
  const { user } = useAuth();
  const action = useAction();
  const [note, setNote] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});
  const [override, setOverride] = useState<DisclosureDto | null>(null);

  const gate = useLoader(`disclosure:${decision?.id ?? 'none'}`, () =>
    decision ? api.getDisclosure(decision.id) : Promise.resolve(null),
  );

  if (!decision) return null;

  const disclosure = override ?? gate.data;
  const decisionId = decision.id;
  const publishable = decision.publishable;
  const vacated = Boolean(decision.vacatedAt);
  const upheld = decision.outcome === 'upheld';
  // The two-moderator rule, mirrored from the service so it is visible before the
  // request rather than after a 403.
  const sameModerator = Boolean(user && decision.issuedBy === user.id);
  const blockedByTwoPerson = kase.grave && sameModerator;

  async function onPublish(event: React.FormEvent) {
    event.preventDefault();
    const parsed = validate(moderationSchemas.setDecisionPublishableInput, {
      publishable: true,
      reviewNote: note,
    });
    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      action.fail(parsed.formErrors[0] ?? 'Explain the basis for publishing this record.');
      return;
    }
    setLocal({});

    const result = await action.run(() => api.setDecisionPublishable(decisionId, parsed.data));
    if (result) {
      setNote('');
      setOverride(result.disclosure);
      onChanged();
    }
  }

  async function onUnpublish() {
    const result = await action.run(() =>
      api.setDecisionPublishable(decisionId, { publishable: false }),
    );
    if (result) {
      setOverride(result.disclosure);
      onChanged();
    }
  }

  return (
    <Card title="Publication review">
      <div className="stack">
        <FormError error={action.error} />

        {/* The gate's live verdict, before anything about the flag. */}
        {gate.loading && !disclosure ? (
          <Loading label="Checking the disclosure gate…" />
        ) : disclosure ? (
          <Callout
            tone={disclosure.disclosable ? 'warn' : 'neutral'}
            title={
              disclosure.disclosable
                ? 'Search would disclose this record right now'
                : 'Search would disclose nothing about this right now'
            }
          >
            {disclosure.reasons.length > 0 ? (
              <ul className="stack tight" style={{ paddingLeft: 20, margin: '6px 0 0' }}>
                {disclosure.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : disclosure.disclosable ? (
              'Every condition the gate checks is satisfied.'
            ) : (
              'The gate reports it is blocked but gave no reason. Treat this as blocked.'
            )}
            {disclosure.effectiveAppealDeadline ? (
              <p className="faint" style={{ margin: '8px 0 0' }}>
                Effective appeal deadline: {formatDateTime(disclosure.effectiveAppealDeadline)} (
                {relativeDays(disclosure.effectiveAppealDeadline)})
              </p>
            ) : null}
          </Callout>
        ) : null}

        {vacated ? (
          <Callout tone="neutral">
            This decision was vacated on appeal. It can never be published, and it is already invisible
            to search.
          </Callout>
        ) : !upheld ? (
          <Callout tone="neutral">
            This decision did not uphold the report, so there is nothing to publish. Only an upheld
            decision can ever become searchable.
          </Callout>
        ) : publishable ? (
          <div className="row between">
            <span className="muted">
              A moderator has cleared this record for publication. Withdrawing that clearance takes
              effect immediately and needs no second review.
            </span>
            <button
              type="button"
              className="btn danger"
              disabled={action.pending}
              onClick={() => void onUnpublish()}
            >
              {action.pending ? 'Working…' : 'Withdraw clearance'}
            </button>
          </div>
        ) : blockedByTwoPerson ? (
          <Callout tone="warn" title="A second moderator has to clear this one">
            You issued this decision and the category is grave, so you cannot also clear it for
            publication. One moderator decides, a different one agrees — or nothing becomes
            searchable.
          </Callout>
        ) : (
          <form className="stack" onSubmit={onPublish} noValidate>
            <Callout tone="warn" title="Read this before clearing it">
              Clearing a record means that anyone who already knows this person&rsquo;s exact email or
              phone number can be told the category and the month of an upheld finding. It cannot be
              taken back from someone who has already seen it.
            </Callout>

            <Field
              label="Basis for publication"
              htmlFor="reviewNote"
              error={local.reviewNote ?? action.fieldErrors.reviewNote}
              hint="Between 10 and 2000 characters. Required, and kept on the audit record against your account."
              aside={<CharCount value={note} min={10} max={2000} />}
            >
              <textarea
                id="reviewNote"
                rows={4}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>

            <div className="row end">
              <SubmitButton pending={action.pending} variant="danger">
                Clear for publication
              </SubmitButton>
            </div>
          </form>
        )}

        <p className="faint">
          Clearance is not disclosure. Even a cleared record is re-checked on every search — the
          appeal window, the subject notification and any pending appeal are all re-read at query
          time, and any one of them blocks it.
        </p>
      </div>
    </Card>
  );
}
