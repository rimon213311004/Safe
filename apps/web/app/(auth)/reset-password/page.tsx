'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { authSchemas } from '@safecheck/shared';
import { api } from '@/lib/api';
import { useAction, validate, type FieldErrors } from '@/lib/hooks';
import { Callout, Card, Field, FormError, SubmitButton } from '@/components/ui';

/**
 * Step two of a password reset: the code from the email, plus the new password.
 *
 * Unlike email confirmation, a successful reset does not sign the user in. The API
 * returns no tokens by design — it has just revoked every session this account had,
 * and issuing a fresh one to whoever sent the request would undo that for the one
 * request most likely not to be the owner's. So this ends on a confirmation with a
 * link to sign in, rather than a redirect into the app.
 */
function ResetPasswordForm() {
  const params = useSearchParams();
  const action = useAction();
  const resend = useAction();

  const [email, setEmail] = useState(params.get('email') ?? '');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});
  const [changed, setChanged] = useState(false);
  const [resent, setResent] = useState(false);

  const fieldError = (field: string) => local[field] ?? action.fieldErrors[field];

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = validate(authSchemas.resetPasswordInput, { email, code, newPassword });
    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      action.fail(parsed.formErrors[0] ?? 'Check the fields below.');
      return;
    }
    setLocal({});

    const ok = await action.run(async () => {
      await api.resetPassword(parsed.data);
      return true;
    });
    if (ok) setChanged(true);
  }

  /**
   * There is no dedicated resend for this purpose — `/auth/resend-otp` only knows
   * about confirmation and sign-in codes — so asking again is just step one again.
   * Issuing a new code invalidates the previous one, which is what a person who
   * cannot find the first email wants.
   */
  async function onResend() {
    setResent(false);
    const parsed = validate(authSchemas.forgotPasswordInput, { email });
    if (!parsed.ok) {
      resend.fail('Enter the address on your account first.');
      return;
    }
    const sent = await resend.run(async () => {
      await api.forgotPassword(parsed.data);
      return true;
    });
    if (sent) setResent(true);
  }

  if (changed) {
    return (
      <Card title="Password changed">
        <div className="stack">
          <Callout tone="success">
            Your password has been updated, and anything still signed in to this account elsewhere has
            been signed out.
          </Callout>
          <p className="muted">
            Sign in with the new password to carry on. If you did not make this change, reset it again
            straight away — whoever did had access to your email.
          </p>
          <Link href="/login" className="btn primary block" style={{ textAlign: 'center' }}>
            Go to sign in
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <Card title="Set a new password">
      <form className="stack" onSubmit={onSubmit} noValidate>
        <FormError error={action.error} />
        {resent ? <Callout tone="success">A new code is on its way.</Callout> : null}
        <FormError error={resend.error} />

        <p className="muted">
          Enter the 6-digit code from the email, then choose the password you want. The code is good
          for 10 minutes.
        </p>

        <Field label="Email" htmlFor="email" error={fieldError('email')}>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            aria-invalid={Boolean(fieldError('email'))}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field label="Reset code" htmlFor="code" error={fieldError('code')}>
          <input
            id="code"
            name="code"
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

        <Field
          label="New password"
          htmlFor="newPassword"
          error={fieldError('newPassword')}
          hint="At least 12 characters, with upper- and lower-case letters and a number."
        >
          <input
            id="newPassword"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            aria-invalid={Boolean(fieldError('newPassword'))}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </Field>

        <SubmitButton pending={action.pending} block>
          Change my password
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

/** `useSearchParams` suspends during prerender, so the form needs its own boundary. */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<Card title="Set a new password">Loading…</Card>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
