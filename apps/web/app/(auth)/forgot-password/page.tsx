'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { authSchemas } from '@safecheck/shared';
import { api } from '@/lib/api';
import { useAction, validate, type FieldErrors } from '@/lib/hooks';
import { Callout, Card, Field, FormError, SubmitButton } from '@/components/ui';

/**
 * Step one of a password reset: ask for a code by email.
 *
 * The API answers the same way for an address that has no account — otherwise this
 * form would tell any stranger who is registered here, which on a platform about
 * personal safety is precisely the thing not to leak. So this screen cannot say
 * "we have emailed you": it doesn't know. It moves to the code form either way and
 * words the promise as the conditional it is.
 */
function ForgotPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const action = useAction();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [local, setLocal] = useState<FieldErrors>({});

  const fieldError = (field: string) => local[field] ?? action.fieldErrors[field];

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = validate(authSchemas.forgotPasswordInput, { email });
    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      action.fail(parsed.formErrors[0] ?? 'Check the fields below.');
      return;
    }
    setLocal({});

    // `run` reports failure by resolving with `undefined`, and the request itself
    // resolves with nothing — so the thunk returns a token to tell the two apart.
    const sent = await action.run(async () => {
      await api.forgotPassword(parsed.data);
      return true;
    });
    if (!sent) return;

    // Pushed, not replaced: Back should return to this form so a mistyped address
    // can be corrected without starting over.
    router.push(`/reset-password?email=${encodeURIComponent(parsed.data.email)}`);
  }

  return (
    <Card title="Reset your password">
      <form className="stack" onSubmit={onSubmit} noValidate>
        <FormError error={action.error} />

        <Callout tone="neutral">
          Enter the address on your account and we will email a 6-digit code. The code lets you set a
          new password without the old one, and signs you out everywhere else.
        </Callout>

        <Field
          label="Email"
          htmlFor="email"
          error={fieldError('email')}
          hint="The address you registered with."
        >
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            autoFocus
            value={email}
            aria-invalid={Boolean(fieldError('email'))}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <SubmitButton pending={action.pending} block>
          Email me a code
        </SubmitButton>

        <div className="row between">
          <Link href="/reset-password" className="faint">
            I already have a code
          </Link>
          <Link href="/login" className="faint">
            Back to sign in
          </Link>
        </div>
      </form>
    </Card>
  );
}

/** `useSearchParams` suspends during prerender, so the form needs its own boundary. */
export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<Card title="Reset your password">Loading…</Card>}>
      <ForgotPasswordForm />
    </Suspense>
  );
}
