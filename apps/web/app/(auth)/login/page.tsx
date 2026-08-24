'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authSchemas } from '@safecheck/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, validate, type FieldErrors } from '@/lib/hooks';
import { Card, Field, FormError, SubmitButton } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const { signIn } = useAuth();
  const action = useAction();
  const [local, setLocal] = useState<FieldErrors>({});
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const fieldError = (name: string) => local[name] ?? action.fieldErrors[name];

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = validate(authSchemas.loginInput, { email, password });
    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      action.fail(parsed.formErrors[0] ?? 'Check the fields below.');
      return;
    }
    setLocal({});

    const result = await action.run(async () => {
      try {
        return await signIn(parsed.data.email, parsed.data.password);
      } catch (cause) {
        // An unverified address is answered with 412 and a fresh code, so the
        // only useful thing to do is take them to where they can enter it.
        if (cause instanceof ApiError && cause.status === 412) {
          router.push(`/verify-email?email=${encodeURIComponent(parsed.data.email)}`);
          return null;
        }
        throw cause;
      }
    });

    if (result) router.replace('/reports');
  }

  return (
    <Card title="Sign in">
      <form className="stack" onSubmit={onSubmit} noValidate>
        <FormError error={action.error} />

        <Field label="Email" htmlFor="email" error={fieldError('email')}>
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

        <Field
          label="Password"
          htmlFor="password"
          error={fieldError('password')}
          aside={
            <Link
              href={email ? `/forgot-password?email=${encodeURIComponent(email)}` : '/forgot-password'}
              className="faint"
            >
              Forgot your password?
            </Link>
          }
        >
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            aria-invalid={Boolean(fieldError('password'))}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <SubmitButton pending={action.pending} block>
          Sign in
        </SubmitButton>

        <p className="faint" style={{ textAlign: 'center' }}>
          No account yet? <Link href="/register">Create one</Link>
        </p>
      </form>
    </Card>
  );
}
