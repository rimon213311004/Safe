'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authSchemas } from '@safecheck/shared';
import { api } from '@/lib/api';
import { useAction, validate, type FieldErrors } from '@/lib/hooks';
import { Callout, Card, Field, FormError, SubmitButton } from '@/components/ui';

/**
 * Registration.
 *
 * The API answers 202 with the same body whether or not the address was already
 * taken, so this screen cannot tell the user "that email is in use" — and must
 * not try to guess. Both paths lead to the same place: enter the code we sent.
 */
export default function RegisterPage() {
  const router = useRouter();
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

    const result = await action.run(() => api.register(parsed.data));
    if (result) router.push(`/verify-email?email=${encodeURIComponent(parsed.data.email)}`);
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
