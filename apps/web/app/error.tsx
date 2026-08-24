'use client';

import Link from 'next/link';

/**
 * Route-level error boundary.
 *
 * Deliberately shows nothing from the error itself. A rendering fault here can
 * have a report's narrative or a subject label in scope, and a stack trace on
 * screen is a disclosure. The digest is enough to find it in the logs.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="auth-page">
      <div className="stack" style={{ alignItems: 'center', textAlign: 'center', maxWidth: 460 }}>
        <span className="eyebrow">Something broke</span>
        <h1>This screen could not be shown</h1>
        <p className="muted">
          Nothing you submitted has been lost. Try again, and if it keeps happening the reference
          below will help us find it.
        </p>
        {error.digest ? <code className="mono faint">{error.digest}</code> : null}
        <div className="btn-group">
          <button type="button" className="btn primary" onClick={reset}>
            Try again
          </button>
          <Link href="/reports" className="btn">
            Back to your reports
          </Link>
        </div>
      </div>
    </main>
  );
}
