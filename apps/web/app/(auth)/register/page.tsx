'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authSchemas } from '@safecheck/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, validate, type FieldErrors } from '@/lib/hooks';
import { Callout, Card, Field, FormError, SubmitButton } from '@/components/ui';

/**
 * Registration.
 *
 * The API answers 202 with the same body whether or not the address was already
 * taken, so this screen cannot tell the user "that email is in use" — and must
 * not try to guess.
 *
 * Where it goes next is the server's call, not this screen's: `verificationRequired`
 * is false when the API has no mail transport configured, in which case the
 * account is already usable and sending the user to a code entry form would strand
 * them waiting for an email nobody can send.
 */
export default function RegisterPage() {
  const router = useRouter();
  const { signIn } = useAuth();
  const action = useAction();
  const [local, setLocal] = useState<FieldErrors>({});
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const fieldError = (field: string) => local[field] ?? action.fieldErrors[field];

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = validate(authSchemas.registerInput, { name, email, password });
    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      action.fail(parsed.formErrors[0] ?? 'Check the fields below.');
      return;
    }
    setLocal({});

    const result = await action.run(async () => {
      const created = await api.register(parsed.data);
      // Signed in here rather than on the next screen: the credentials are in
      // hand, and bouncing through a login form to retype them adds friction for
      // nothing. A failure here is reported like any other — the account exists
      // either way, so the sign-in page still works.
      if (!created.verificationRequired) {
        await signIn(parsed.data.email, parsed.data.password);
      }
      return created;
    });

    if (!result) return;
    router.replace(
      result.verificationRequired
        ? `/verify-email?email=${encodeURIComponent(parsed.data.email)}`
        : '/reports',
    );
  }

  return (
    <Card title="Create an account">
      <form className="stack" onSubmit={onSubmit} noValidate>
        <FormError error={action.error} />

        <Callout tone="neutral">
          An account lets you file reports, answer one made about you, and check an identifier you
          already have. Searching is tied to your account and recorded, so that disclosure about
          another person is always attributable to someone.
        </Callout>

        <Field label="Your name" htmlFor="name" error={fieldError('name')}>
          <input
            id="name"
            type="text"
            autoComplete="name"
            autoFocus
            value={name}
            aria-invalid={Boolean(fieldError('name'))}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <Field label="Email" htmlFor="email" error={fieldError('email')} hint="We send a 6-digit code here to confirm it is yours.">
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            aria-invalid={Boolean(fieldError('email'))}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          error={fieldError('password')}
          hint="At least 12 characters, with upper- and lower-case letters and a number."
        >
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            aria-invalid={Boolean(fieldError('password'))}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <SubmitButton pending={action.pending} block>
          Create account
        </SubmitButton>

        <p className="faint" style={{ textAlign: 'center' }}>
          Already registered? <Link href="/login">Sign in</Link>
        </p>
      </form>
    </Card>
  );
}
