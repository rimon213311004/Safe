import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="auth-page">
      <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
        <span className="eyebrow">404</span>
        <h1>That page does not exist</h1>
        <p className="lede" style={{ textAlign: 'center' }}>
          If you followed a link to a report or a case, it may have been withdrawn — or it may
          belong to someone else. Either way there is nothing here.
        </p>
        <Link href="/" className="btn primary">
          Back to SafeCheck
        </Link>
      </div>
    </main>
  );
}
