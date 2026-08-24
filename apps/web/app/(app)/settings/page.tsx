'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authSchemas } from '@safecheck/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, validate, type FieldErrors } from '@/lib/hooks';
import { formatDate } from '@/lib/labels';
import { Badge, Callout, Card, Facts, Field, FormError, PageHead, SubmitButton } from '@/components/ui';

/**
 * Account settings.
 *
 * Small on purpose. The only mutation here is the password, and the page is
 * explicit that changing it ends the session everywhere — the API revokes the
 * refresh token family, so this is a fact to state up front rather than a surprise
 * to discover at the next request.
 */
export default function SettingsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const action = useAction();

  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});

  if (!user) return null;

  const fieldError = (name: string) => local[name] ?? action.fieldErrors[name];

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();

    // Confirmation is a browser-side courtesy; the contract has no such field, so
    // it is checked before validation rather than sent.
    if (newPassword !== confirm) {
      setLocal({ confirm: ['These two do not match.'] });
      action.fail('The new password and its confirmation are different.');
      return;
    }

    const parsed = validate(authSchemas.changePasswordInput, { currentPassword, newPassword });
    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      action.fail(parsed.formErrors[0] ?? 'Check the fields below.');
      return;
    }
    setLocal({});

    const done = await action.run(() => api.changePassword(parsed.data));
    // `changePassword` clears the session itself, because the API has revoked the
    // refresh cookie by the time it answers. Send them to sign in again.
    if (done === undefined && !action.error) router.replace('/login');
  }

  return (
    <div className="stack loose">
      <PageHead title="Account">
        Your details, and what SafeCheck holds about you.
      </PageHead>

      <Card title="Your details">
        <Facts
          items={[
            ['Name', user.name],
            ['Email', <span className="mono" key="email">{user.email}</span>],
            [
              'Email confirmed',
              user.emailVerified ? (
                <Badge tone="done">Confirmed</Badge>
              ) : (
                <Badge tone="alert">Not confirmed</Badge>
              ),
            ],
            ['Role', user.role === 'user' ? 'Standard account' : user.role],
            ['Member since', formatDate(user.createdAt)],
          ]}
        />
      </Card>

      <Card title="Change your password">
        <form className="stack" onSubmit={onSubmit} noValidate>
          <FormError error={action.error} />

          <Callout tone="warn">
            Changing your password signs you out on every device, including this one. You will need to
            sign in again with the new password.
          </Callout>

          <Field
            label="Current password"
            htmlFor="currentPassword"
            error={fieldError('currentPassword')}
          >
            <input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>

          <Field
            label="New password"
            htmlFor="newPassword"
            error={fieldError('newPassword')}
            hint="At least 12 characters, with an uppercase letter, a lowercase letter and a digit."
          >
            <input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>

          <Field label="Confirm new password" htmlFor="confirm" error={fieldError('confirm')}>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>

          <div className="row end">
            <SubmitButton pending={action.pending}>Change password</SubmitButton>
          </div>
        </form>
      </Card>

      <Card title="What we hold about you">
        <div className="stack tight muted">
          <p>
            Your email address, your name, and the reports you have filed. Identifiers you enter about
            other people are stored as keyed hashes, never as readable text, which is why nothing on
            this platform can produce a list of reported people.
          </p>
          <p>
            Every search you run is recorded against your account, including ones that returned
            nothing. That record exists so that misuse of search can be detected, and it is the reason
            search is limited to one exact identifier at a time.
          </p>
          <p>
            Reports and decisions are kept for audit even after they are withdrawn or vacated. What
            changes is whether anything can be disclosed from them — not whether the record exists.
          </p>
        </div>
      </Card>
    </div>
  );
}
