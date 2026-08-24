'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { authSchemas } from '@safecheck/shared';
import { api } from '@/lib/api';
import { useAction, validate, type FieldErrors } from '@/lib/hooks';
import { Callout, Card, Field, FormError, SubmitButton } from '@/components/ui';

/**
 * Email confirmation.
 *
 * Verifying signs the user in — the API establishes a session as part of
 * consuming the code — so there is no second sign-in step after this.
 */
function VerifyEmailForm() {
  const router = useRouter();
  const params = useSearchParams();
  const action = useAction();
  const resend = useAction();

  const [email, setEmail] = useState(params.get('email') ?? '');
  const [code, setCode] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});
  const [resent, setResent] = useState(false);

  const fieldError = (field: string) => local[field] ?? action.fieldErrors[field];

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = validate(authSchemas.verifyEmailInput, { email, code });
    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      action.fail(parsed.formErrors[0] ?? 'Check the fields below.');
      return;
    }
    setLocal({});

    const user = await action.run(() => api.verifyEmail(parsed.data));
    if (user) router.replace('/reports');
  }

  async function onResend() {
    setResent(false);
    const parsed = validate(authSchemas.resendOtpInput, { email, purpose: 'verify_email' });
    if (!parsed.ok) {
      resend.fail('Enter the address you registered with first.');
      return;
    }
    const done = await resend.run(() => api.resendOtp(parsed.data.email, parsed.data.purpose));
    // `undefined` is the success value here — the call resolves with nothing — so
    // check for the absence of an error rather than for a truthy result.
    if (done === undefined && !resend.error) setResent(true);
  }

  return (
    <Card title="Confirm your email">
      <form className="stack" onSubmit={onSubmit} noValidate>
        <FormError error={action.error} />
        {resent ? <Callout tone="success">A new code is on its way.</Callout> : null}
        <FormError error={resend.error} />

        <p className="muted">
          We sent a 6-digit code to your email address. Entering it confirms the address and signs
          you in.
        </p>

        <Field label="Email" htmlFor="email" error={fieldError('email')}>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            aria-invalid={Boolean(fieldError('email'))}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field label="Confirmation code" htmlFor="code" error={fieldError('code')}>
          <input
            id="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            placeholder="123456"
            value={code}
            aria-invalid={Boolean(fieldError('code'))}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            style={{ letterSpacing: '0.35em', fontFamily: 'var(--font-mono)' }}
          />
        </Field>

        <SubmitButton pending={action.pending} block>
          Confirm and sign in
        </SubmitButton>

        <div className="row between">
          <button type="button" className="btn ghost small" onClick={onResend} disabled={resend.pending}>
            {resend.pending ? 'Sending…' : 'Send a new code'}
          </button>
          <Link href="/login" className="faint">
            Back to sign in
          </Link>
        </div>
      </form>
    </Card>
  );
}

/**
 * `useSearchParams` suspends during prerender, so the form needs a boundary of
 * its own rather than inheriting the route's.
 */
export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<Card title="Confirm your email">Loading…</Card>}>
      <VerifyEmailForm />
    </Suspense>
  );
}
