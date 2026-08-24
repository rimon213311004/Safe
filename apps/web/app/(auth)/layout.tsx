'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

/**
 * Chrome for the sign-in, registration and verification screens.
 *
 * Anyone who already has a session is moved on: showing a signed-in user a login
 * form invites them to authenticate twice, and the second attempt would rotate a
 * perfectly good session for no reason.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated') router.replace('/reports');
  }, [status, router]);

  return (
    <main className="auth-page">
      <Link href="/" className="brand">
        <span className="mark" aria-hidden="true">
          SC
        </span>
        SafeCheck
      </Link>
      <div className="auth-card">{children}</div>
      <p className="footnote">
        SafeCheck is not an emergency service. If you are in immediate danger, contact your local
        emergency number.
      </p>
    </main>
  );
}
