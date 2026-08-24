'use client';

import { useState } from 'react';
import Link from 'next/link';
import { appealSchemas } from '@safecheck/shared';
import { api } from '@/lib/api';
import { useAuth, useRequireAuth } from '@/lib/auth';
import { useAction, useLoader, validate, type FieldErrors } from '@/lib/hooks';
import { appealPartyLabel, appealStateLabel, formatDateTime, outcomeLabel } from '@/lib/labels';
import type { PendingAppealDto } from '@/lib/api-types';
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
 * The appeals queue.
 *
 * An appeal is reviewed by a moderator who was not involved in the decision — the
 * API enforces that on both claim and resolve. This page checks the same thing
 * locally so a moderator sees "not yours to review" instead of discovering it
 * through a 403 after reading the whole file.
 */
export default function AppealsQueuePage() {
  const { status } = useRequireAuth('moderator');
  const loader = useLoader('appeals:pending', () => api.listPendingAppeals(50));
  const [openId, setOpenId] = useState<string | null>(null);

  if (status !== 'authenticated') return null;

  const appeals = loader.data ?? [];

  return (
    <div className="stack loose">
      <PageHead title="Appeals">
        Decisions that a party has asked to have looked at again. Granting an appeal can take a
        decision out of effect entirely.
      </PageHead>

      {loader.error ? <Callout tone="danger">{loader.error}</Callout> : null}

      {loader.loading && !loader.data ? (
        <Loading label="Loading appeals…" />
      ) : appeals.length === 0 ? (
        <Card>
          <Empty title="No appeals awaiting review">
            Filed appeals appear here until they are resolved or withdrawn.
          </Empty>
        </Card>
      ) : (
        <div className="stack">
          {appeals.map((appeal) => (
            <AppealCard
              key={appeal.id}
              appeal={appeal}
              open={openId === appeal.id}
              onToggle={() => setOpenId((current) => (current === appeal.id ? null : appeal.id))}
              onChanged={loader.reload}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AppealCard({
  appeal,
  open,
  onToggle,
  onChanged,
}: {
  appeal: PendingAppealDto;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const action = useAction();

  const conflicted = Boolean(user && appeal.decisionIssuedBy === user.id);
  const claimed = appeal.state === 'under_review';
  const mine = Boolean(user && appeal.reviewerId === user.id);

  async function onClaim() {
    const done = await action.run(() => api.claimAppeal(appeal.id));
    if (done) onChanged();
  }

  return (
    <Card
      title={`${appealPartyLabel(appeal.party)} appealed`}
      actions={
        <div className="row">
          <Badge tone={claimed ? 'active' : 'open'}>{appealStateLabel(appeal.state)}</Badge>
          <button type="button" className="btn ghost small" onClick={onToggle}>
            {open ? 'Collapse' : 'Review'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <Facts
          items={[
            ['Filed', formatDateTime(appeal.filedAt)],
            ['Decision appealed', appeal.decisionOutcome ? outcomeLabel(appeal.decisionOutcome) : null],
            [
              'Report',
              <Link href={`/reports/${appeal.reportId}`} key="report">
                Open the report
              </Link>,
            ],
            ['Reviewer', claimed ? (mine ? 'You' : 'Another moderator') : 'Unclaimed'],
          ]}
        />

        {open ? (
          <>
            <hr className="rule" />
            <div className="stack tight">
              <span className="eyebrow">Grounds for appeal</span>
              <p className="prose">{appeal.grounds}</p>
            </div>

            <FormError error={action.error} />

            {conflicted ? (
              <Callout tone="warn" title="Not yours to review">
                You issued the decision being appealed. Another moderator has to review this one — that
                is what makes an appeal an appeal.
              </Callout>
            ) : claimed && !mine ? (
              <Callout tone="neutral">
                Another moderator has claimed this appeal and is reviewing it.
              </Callout>
            ) : claimed ? (
              <ResolveForm appealId={appeal.id} onChanged={onChanged} />
            ) : (
              <div className="row between">
                <span className="muted">
                  Claiming an appeal records you as its reviewer and takes it out of the unclaimed
                  list.
                </span>
                <button
                  type="button"
                  className="btn primary"
                  disabled={action.pending}
                  onClick={() => void onClaim()}
                >
                  {action.pending ? 'Claiming…' : 'Claim this appeal'}
                </button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </Card>
  );
}

type Effect = 'vacate' | 'amend' | 'uphold_original';

const EFFECTS: Array<{ value: Effect; title: string; note: string }> = [
  {
    value: 'vacate',
    title: 'Vacate the decision',
    note: 'The decision stops having effect, any clearance for publication is revoked, and the report goes back for a fresh decision. The vacated decision stays on record.',
  },
  {
    value: 'amend',
    title: 'Amend the decision',
    note: 'Behaves as vacate-and-re-decide: the original comes out of effect and the report returns for a new decision.',
  },
  {
    value: 'uphold_original',
    title: 'Uphold the original outcome',
    note: 'The appeal succeeded on its own terms — a process failure, say — but the outcome itself stands.',
  },
];

function ResolveForm({ appealId, onChanged }: { appealId: string; onChanged: () => void }) {
  const action = useAction();
  const [decision, setDecision] = useState<'granted' | 'denied' | ''>('');
  const [effect, setEffect] = useState<Effect | ''>('');
  const [rationale, setRationale] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});

  const fieldError = (name: string) => local[name] ?? action.fieldErrors[name];

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    // `effect` is required when granting — a root-level refine in the contract, so
    // it arrives in formErrors rather than on the field.
    const parsed = validate(appealSchemas.resolveAppealInput, {
      decision: decision || undefined,
      rationale,
      effect: decision === 'granted' ? effect || undefined : undefined,
    });
    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      action.fail(parsed.formErrors[0] ?? 'Check the fields below.');
      return;
    }
    setLocal({});

    const done = await action.run(() => api.resolveAppeal(appealId, parsed.data));
    if (done) onChanged();
  }

  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <FormError error={action.error} />

      <div className="field">
        <span className="field-label">Your conclusion</span>
        <div className="choices">
          <label className="choice">
            <input
              type="radio"
              name={`decision-${appealId}`}
              checked={decision === 'granted'}
              onChange={() => setDecision('granted')}
            />
            <span>
              <span className="choice-title">Grant the appeal</span>
              <span className="choice-note">The appeal has merit. Choose what that means below.</span>
            </span>
          </label>
          <label className="choice">
            <input
              type="radio"
              name={`decision-${appealId}`}
              checked={decision === 'denied'}
              onChange={() => {
                setDecision('denied');
                setEffect('');
              }}
            />
            <span>
              <span className="choice-title">Deny the appeal</span>
              <span className="choice-note">
                The original decision stands as it is. The appeal window does not reopen.
              </span>
            </span>
          </label>
        </div>
        {fieldError('decision') ? <span className="err">{fieldError('decision')?.[0]}</span> : null}
      </div>

      {decision === 'granted' ? (
        <div className="field">
          <span className="field-label">What granting it does</span>
          <div className="choices">
            {EFFECTS.map((option) => (
              <label className="choice" key={option.value}>
                <input
                  type="radio"
                  name={`effect-${appealId}`}
                  checked={effect === option.value}
                  onChange={() => setEffect(option.value)}
                />
                <span>
                  <span className="choice-title">{option.title}</span>
                  <span className="choice-note">{option.note}</span>
                </span>
              </label>
            ))}
          </div>
          {fieldError('effect') ? <span className="err">{fieldError('effect')?.[0]}</span> : null}
        </div>
      ) : null}

      <Field
        label="Rationale"
        htmlFor={`rationale-${appealId}`}
        error={fieldError('rationale')}
        hint="Between 20 and 4000 characters. The party who appealed will read this."
        aside={<CharCount value={rationale} min={20} max={4000} />}
      >
        <textarea
          id={`rationale-${appealId}`}
          rows={7}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
        />
      </Field>

      <div className="row end">
        <SubmitButton pending={action.pending}>Resolve appeal</SubmitButton>
      </div>
    </form>
  );
}
