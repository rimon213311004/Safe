'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { REPORT_CATEGORIES, isGraveCategory, reportSchemas, type ReportCategory } from '@safecheck/shared';
import { api } from '@/lib/api';
import { useAction, validate, type FieldErrors } from '@/lib/hooks';
import { categoryLabel, toInstant } from '@/lib/labels';
import { Callout, Card, CharCount, Field, FormError, PageHead, SubmitButton } from '@/components/ui';

/**
 * Filing a report.
 *
 * The form mirrors `createReportInput` exactly and validates with that schema
 * before sending, so the browser and the server agree on every bound. Two parts
 * are worth reading:
 *
 *  • The subject's email or phone is what lets us match reports about the same
 *    person and, later, notify them that a decision has been made. The server
 *    hashes it on arrival and never stores the plaintext, which is why the form
 *    warns that it cannot be shown back or corrected afterwards.
 *
 *  • `attestation` is a hard `z.literal(true)` in the contract. It is a checkbox
 *    here rather than fine print because a false report has consequences for a
 *    real person, and the user should have to say so deliberately.
 */

/** Local form state, kept as strings so inputs stay controlled and uncoerced. */
interface Draft {
  category: ReportCategory | '';
  subjectEmail: string;
  subjectPhone: string;
  knownAs: string;
  description: string;
  incidentAt: string;
  location: string;
  attestation: boolean;
  submitNow: boolean;
}

const EMPTY: Draft = {
  category: '',
  subjectEmail: '',
  subjectPhone: '',
  knownAs: '',
  description: '',
  incidentAt: '',
  location: '',
  attestation: false,
  submitNow: true,
};

export default function NewReportPage() {
  const router = useRouter();
  const action = useAction();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [local, setLocal] = useState<FieldErrors>({});

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const fieldError = (name: string) => local[name] ?? action.fieldErrors[name];
  const grave = draft.category !== '' && isGraveCategory(draft.category);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();

    const parsed = validate(reportSchemas.createReportInput, {
      category: draft.category || undefined,
      subject: {
        email: draft.subjectEmail.trim() || undefined,
        phone: draft.subjectPhone.trim() || undefined,
        knownAs: draft.knownAs.trim() || undefined,
      },
      description: draft.description,
      incidentAt: toInstant(draft.incidentAt),
      location: draft.location.trim() || undefined,
      // Sent as-is: an unchecked box must fail the contract's literal(true), not
      // be quietly coerced into one.
      attestation: draft.attestation,
      submitNow: draft.submitNow,
    });

    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      // The subject rule ("provide at least an email or a phone") lives on the
      // nested object, so it lands in formErrors rather than on a field.
      action.fail(parsed.formErrors[0] ?? 'Some fields need your attention.');
      return;
    }
    setLocal({});

    const report = await action.run(() => api.createReport(parsed.data));
    if (report) router.replace(`/reports/${report.id}`);
  }

  return (
    <div className="stack loose">
      <PageHead title="File a report">
        Describe what happened in your own words. You can save this as a draft, attach evidence, and
        submit it when you are ready.
      </PageHead>

      <form className="stack" onSubmit={onSubmit} noValidate>
        <FormError error={action.error} />

        <Card title="What happened">
          <div className="stack">
            <Field label="Category" htmlFor="category" error={fieldError('category')}>
              <select
                id="category"
                value={draft.category}
                aria-invalid={Boolean(fieldError('category'))}
                onChange={(e) => set('category', e.target.value as ReportCategory)}
              >
                <option value="">Choose the closest match…</option>
                {REPORT_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {categoryLabel(category)}
                  </option>
                ))}
              </select>
            </Field>

            {grave ? (
              <Callout tone="warn" title="This category is handled more strictly">
                Reports in this category are reviewed with a longer, non-shortenable appeal window,
                and a second moderator must agree before any outcome could ever appear in search.
                That is slower on purpose.
              </Callout>
            ) : null}

            <Field
              label="Your account of what happened"
              htmlFor="description"
              error={fieldError('description')}
              hint="Between 40 and 8000 characters. Include dates, what was said or done, and anything a moderator would need to understand it."
              aside={<CharCount value={draft.description} min={40} max={8000} />}
            >
              <textarea
                id="description"
                rows={11}
                value={draft.description}
                aria-invalid={Boolean(fieldError('description'))}
                onChange={(e) => set('description', e.target.value)}
              />
            </Field>

            <div className="grid">
              <Field
                label="When did it happen?"
                htmlFor="incidentAt"
                error={fieldError('incidentAt')}
                hint="Optional. If it happened more than once, use the most recent."
              >
                <input
                  id="incidentAt"
                  type="datetime-local"
                  value={draft.incidentAt}
                  onChange={(e) => set('incidentAt', e.target.value)}
                />
              </Field>

              <Field
                label="Where did it happen?"
                htmlFor="location"
                error={fieldError('location')}
                hint="Optional and deliberately coarse — a city, a platform, a workplace."
              >
                <input
                  id="location"
                  type="text"
                  maxLength={200}
                  placeholder="e.g. Dhaka, or a messaging app"
                  value={draft.location}
                  onChange={(e) => set('location', e.target.value)}
                />
              </Field>
            </div>
          </div>
        </Card>

        <Card title="Who it concerns">
          <div className="stack">
            <Callout tone="neutral">
              We need one exact identifier so the same person can be matched across reports and told
              when a decision is made about them. It is stored as a keyed hash, never as plain text —
              so it cannot be shown back to you, corrected later, or read out of our database as a
              list of names. Check it before you submit.
            </Callout>

            <div className="grid">
              <Field
                label="Their email address"
                htmlFor="subjectEmail"
                error={fieldError('subject.email') ?? fieldError('email')}
              >
                <input
                  id="subjectEmail"
                  type="email"
                  autoComplete="off"
                  placeholder="name@example.com"
                  value={draft.subjectEmail}
                  onChange={(e) => set('subjectEmail', e.target.value)}
                />
              </Field>

              <Field
                label="Their phone number"
                htmlFor="subjectPhone"
                error={fieldError('subject.phone') ?? fieldError('phone')}
                hint="International format, e.g. +8801712345678."
              >
                <input
                  id="subjectPhone"
                  type="tel"
                  autoComplete="off"
                  placeholder="+8801712345678"
                  value={draft.subjectPhone}
                  onChange={(e) => set('subjectPhone', e.target.value)}
                />
              </Field>
            </div>

            <p className="faint">
              One of the two is enough. An email address is what lets us notify them; a phone number
              alone means we may not be able to, and an outcome can never be published about someone
              we could not tell.
            </p>

            <Field
              label="What do they go by?"
              htmlFor="knownAs"
              error={fieldError('subject.knownAs')}
              hint="Optional. A label to help moderators keep cases apart. It is never used for matching or searching."
            >
              <input
                id="knownAs"
                type="text"
                maxLength={120}
                value={draft.knownAs}
                onChange={(e) => set('knownAs', e.target.value)}
              />
            </Field>
          </div>
        </Card>

        <Card title="Before you file">
          <div className="stack">
            <label className="check">
              <input
                type="checkbox"
                checked={draft.attestation}
                onChange={(e) => set('attestation', e.target.checked)}
              />
              <span>
                I confirm this account is truthful and given in good faith. I understand a knowingly
                false report has consequences for a real person and for my account.
              </span>
            </label>
            {fieldError('attestation') ? (
              <span className="err">{fieldError('attestation')?.[0]}</span>
            ) : null}

            <hr className="rule" />

            <div className="choices">
              <label className="choice">
                <input
                  type="radio"
                  name="submitNow"
                  checked={draft.submitNow}
                  onChange={() => set('submitNow', true)}
                />
                <span>
                  <span className="choice-title">Submit now</span>
                  <span className="choice-note">
                    Goes into the moderation queue immediately. You can still add evidence
                    afterwards.
                  </span>
                </span>
              </label>
              <label className="choice">
                <input
                  type="radio"
                  name="submitNow"
                  checked={!draft.submitNow}
                  onChange={() => set('submitNow', false)}
                />
                <span>
                  <span className="choice-title">Save as a draft</span>
                  <span className="choice-note">
                    Nobody sees it until you submit. Use this if you want to attach evidence or edit
                    the description first.
                  </span>
                </span>
              </label>
            </div>

            <div className="row between">
              <Link href="/reports" className="btn ghost">
                Cancel
              </Link>
              <SubmitButton pending={action.pending}>
                {draft.submitNow ? 'Submit report' : 'Save draft'}
              </SubmitButton>
            </div>
          </div>
        </Card>
      </form>
    </div>
  );
}
