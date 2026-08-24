'use client';

import Link from 'next/link';
import { SEARCH_DISCLAIMER } from '@safecheck/shared';
import { useAuth } from '@/lib/auth';

/**
 * The public landing page.
 *
 * It leads with what the product will not do, because that is the part a visitor
 * cannot verify for themselves and the part that decides whether they should
 * trust it with a report. The four guarantees below are not marketing copy —
 * each one names a mechanism that exists in the API and can be checked.
 */

const GUARANTEES = [
  {
    title: 'No browsing people',
    body:
      'You can confirm something about an email or phone number you already have. There is no name search, no partial match, and no way to enumerate anyone.',
  },
  {
    title: 'Nothing under review is ever shown',
    body:
      'A report becomes visible only after it is upheld on review, the person it concerns has been notified, and their appeal window has closed with no appeal pending.',
  },
  {
    title: 'Deciding is not publishing',
    body:
      'A moderator who reaches a finding cannot make it public in the same act. Grave allegations need a second moderator to clear them for publication.',
  },
  {
    title: 'We hold no directory of reported people',
    body:
      'Identifiers are stored only as keyed hashes, so the database cannot be read back into a list of names. Evidence is encrypted at rest and never served from a public URL.',
  },
];

export default function LandingPage() {
  const { status } = useAuth();
  const signedIn = status === 'authenticated';

  return (
    <>
      <header className="topbar">
        <div className="container wide">
          <Link href="/" className="brand">
            <span className="mark" aria-hidden="true">
              SC
            </span>
            SafeCheck
          </Link>
          <nav className="btn-group keep-inline">
            {signedIn ? (
              <Link href="/reports" className="btn primary">
                Go to your reports
              </Link>
            ) : (
              <>
                <Link href="/login" className="btn">
                  Sign in
                </Link>
                <Link href="/register" className="btn primary">
                  Create an account
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="container wide">
            <div className="stack loose">
              <div className="stack">
                <span className="eyebrow chip">
                  Personal safety · verification · incident reporting
                </span>
                <h1 className="display">
                  A safety record you can check — and a process the person it concerns can answer.
                </h1>
                <p className="lede">
                  SafeCheck adjudicates incident reports and publishes only what survives review and
                  appeal. It is built so that being reported is not the same as being marked, and so
                  that checking someone cannot become a way to expose them.
                </p>
              </div>

              <div className="btn-group">
                {signedIn ? (
                  <>
                    <Link href="/search" className="btn primary">
                      Check an identifier
                    </Link>
                    <Link href="/reports/new" className="btn">
                      File a report
                    </Link>
                  </>
                ) : (
                  <>
                    <Link href="/register" className="btn primary">
                      Create an account
                    </Link>
                    <Link href="/login" className="btn">
                      I already have one
                    </Link>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="container wide" style={{ paddingBottom: 48 }}>
          <div className="stack loose">
            <div className="stack tight">
              <h2>What this platform will not do</h2>
              <p className="muted" style={{ maxWidth: '62ch' }}>
                Every guarantee here is enforced in one place in the codebase rather than trusted to
                the interface, so a change to a screen cannot loosen it.
              </p>
            </div>

            <ul className="pledge">
              {GUARANTEES.map((item) => (
                <li key={item.title}>
                  <div className="pledge-title">{item.title}</div>
                  <div className="pledge-body">{item.body}</div>
                </li>
              ))}
            </ul>

            <div className="callout neutral">
              <span className="callout-title">The disclaimer shown with every search result</span>
              <span>{SEARCH_DISCLAIMER}</span>
            </div>
          </div>
        </section>

        <section className="container wide" style={{ paddingBottom: 80 }}>
          <div className="grid">
            <article className="card">
              <h3>If you need to report something</h3>
              <p className="muted" style={{ marginTop: 8 }}>
                Describe what happened in your own words and attach anything that supports it. You
                can save a draft first and add evidence before submitting. You will be told when a
                moderator picks it up and what they decide.
              </p>
            </article>
            <article className="card">
              <h3>If you have been reported</h3>
              <p className="muted" style={{ marginTop: 8 }}>
                You are notified when a decision is issued, you are told the reasoning, and you have
                a fixed window to appeal it — reviewed by a different moderator. Nothing about you
                becomes searchable while that window is open or an appeal is pending.
              </p>
            </article>
            <article className="card">
              <h3>If you are checking someone</h3>
              <p className="muted" style={{ marginTop: 8 }}>
                Enter the exact email or phone number you already have. You will see whether it maps
                to a verified account and any fully adjudicated outcomes — a category, a month, and
                nothing more. Never the narrative, the evidence, or who reported it.
              </p>
            </article>
          </div>
        </section>
      </main>

      <footer className="container wide" style={{ paddingBottom: 48 }}>
        <p className="faint">
          SafeCheck is not an emergency service. If you are in immediate danger, contact your local
          emergency number.
        </p>
      </footer>
    </>
  );
}
