'use client';

import { useState } from 'react';
import { searchSchemas, type SearchResult } from '@safecheck/shared';
import { api } from '@/lib/api';
import { useAction, validate, type FieldErrors } from '@/lib/hooks';
import { categoryLabel, formatMonth } from '@/lib/labels';
import { Badge, Callout, Card, Empty, Field, FormError, PageHead, Segmented, SubmitButton } from '@/components/ui';

/**
 * Search.
 *
 * This is the only screen where the platform says something about a person to
 * someone who is not that person, so it is written defensively:
 *
 *  • One exact identifier, chosen explicitly. No combined field that might be
 *    read as a name box, and no way to submit both.
 *
 *  • The empty state says nothing about the person. The API returns a
 *    byte-identical response for "we have never heard of this address" and "we
 *    hold reports about them that are not disclosable", and this screen must not
 *    undo that by wording the two differently. "Nothing to show" is the whole
 *    truth we are allowed to tell.
 *
 *  • The disclaimer is rendered from the response, not from a local constant, so
 *    it is present on every result including empty ones.
 */

type Mode = 'email' | 'phone';

export default function SearchPage() {
  const action = useAction();
  const [mode, setMode] = useState<Mode>('email');
  const [value, setValue] = useState('');
  const [local, setLocal] = useState<FieldErrors>({});
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searched, setSearched] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = validate(searchSchemas.searchInput, { [mode]: value.trim() || undefined });
    if (!parsed.ok) {
      setLocal(parsed.fieldErrors);
      action.fail(parsed.formErrors[0] ?? 'Enter one email address or one phone number.');
      return;
    }
    setLocal({});

    const found = await action.run(() => api.search(parsed.data));
    if (found) {
      setResult(found);
      setSearched(value.trim());
    }
  }

  function onModeChange(next: Mode | null) {
    if (!next || next === mode) return;
    setMode(next);
    setValue('');
    setLocal({});
    action.reset();
    // Clearing the previous result matters: leaving it on screen under a new
    // input would attach one person's outcome to another person's identifier.
    setResult(null);
    setSearched(null);
  }

  return (
    <div className="stack loose">
      <PageHead title="Check an identifier">
        Enter an email address or phone number you already have. There is no name search and no
        partial match — you can confirm what we hold about an identifier, not discover who it
        belongs to.
      </PageHead>

      <Card>
        <form className="stack" onSubmit={onSubmit} noValidate>
          <FormError error={action.error} />

          <Segmented<Mode>
            label="What are you checking"
            value={mode}
            onChange={onModeChange}
            options={[
              { value: 'email', label: 'Email address' },
              { value: 'phone', label: 'Phone number' },
            ]}
          />

          {mode === 'email' ? (
            <Field label="Email address" htmlFor="q" error={local.email ?? action.fieldErrors.email}>
              <input
                id="q"
                type="email"
                autoComplete="off"
                placeholder="name@example.com"
                value={value}
                aria-invalid={Boolean(local.email ?? action.fieldErrors.email)}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
          ) : (
            <Field
              label="Phone number"
              htmlFor="q"
              error={local.phone ?? action.fieldErrors.phone}
              hint="International format, including the country code — for example +8801712345678."
            >
              <input
                id="q"
                type="tel"
                autoComplete="off"
                placeholder="+8801712345678"
                value={value}
                aria-invalid={Boolean(local.phone ?? action.fieldErrors.phone)}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
          )}

          <div className="row between">
            <SubmitButton pending={action.pending}>Check</SubmitButton>
            <span className="faint">
              Every search is recorded against your account, including ones that return nothing.
            </span>
          </div>
        </form>
      </Card>

      {result ? <Result result={result} searched={searched} /> : <BeforeSearch />}
    </div>
  );
}

/** Sets expectations before anyone types, so an empty result is not a surprise. */
function BeforeSearch() {
  return (
    <Card title="What a result can and cannot contain">
      <ul className="stack tight muted" style={{ paddingLeft: 20, margin: 0 }}>
        <li>Whether the address belongs to a SafeCheck account with a confirmed identity.</li>
        <li>Anything that account holder chose to publish about themselves.</li>
        <li>
          Safety outcomes that were upheld on review, where the person has been notified and their
          appeal window has closed with no appeal pending.
        </li>
        <li>
          Never the report itself, the evidence, who filed it, or an exact date — outcomes carry a
          month and nothing finer.
        </li>
        <li>Never anything under review. A report in progress is invisible here.</li>
      </ul>
    </Card>
  );
}

function Result({ result, searched }: { result: SearchResult; searched: string | null }) {
  const { account, records } = result;
  const nothing = !account && records.length === 0;

  return (
    <div className="stack">
      {searched ? (
        <span className="eyebrow">
          Result for <span className="mono">{searched}</span>
        </span>
      ) : null}

      {nothing ? (
        <Card>
          <Empty title="Nothing to show for this identifier">
            {/*
              Worded to carry no inference in either direction. This exact
              sentence must cover both "unknown to us" and "known but not
              disclosable" — the API cannot tell them apart on the wire, and
              neither may this screen.
            */}
            SafeCheck has nothing it can show you about this identifier. That is not a statement
            about the person, and it does not mean no account exists.
          </Empty>
        </Card>
      ) : (
        <>
          <Card title="Account">
            {account ? (
              <div className="stack">
                <div className="row">
                  {account.verified ? (
                    <Badge tone="done">Identity verified</Badge>
                  ) : (
                    <Badge tone="draft">Identity not verified</Badge>
                  )}
                  {account.verified && account.verifiedMonth ? (
                    <span className="muted">since {formatMonth(account.verifiedMonth)}</span>
                  ) : null}
                </div>

                {account.selfPublished.length > 0 ? (
                  <div className="stack tight">
                    <span className="eyebrow">Published by the account holder</span>
                    <ul className="stack tight" style={{ paddingLeft: 20, margin: 0 }}>
                      {account.selfPublished.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="faint">This account has not published anything about itself.</p>
                )}
              </div>
            ) : (
              <p className="muted">
                This identifier is not a confirmed SafeCheck account. A phone number never is —
                accounts are identified by email.
              </p>
            )}
          </Card>

          <Card title={`Safety records (${records.length})`}>
            {records.length === 0 ? (
              <Empty title="No published safety records">
                Nothing about this identifier has completed review and passed its appeal window.
              </Empty>
            ) : (
              <ul className="list">
                {records.map((record, index) => (
                  <li key={`${record.category}-${record.decidedMonth}-${index}`}>
                    <div className="list-row">
                      <div className="list-main">
                        <span className="list-title">{categoryLabel(record.category)}</span>
                        <span className="faint">
                          Decided {formatMonth(record.decidedMonth)} ·{' '}
                          {record.appealStatus === 'exhausted'
                            ? 'appealed and resolved'
                            : 'not appealed'}
                        </span>
                      </div>
                      <Badge tone="done">Upheld</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {/* Rendered from the response so it appears on empty results too. */}
      <Callout tone="neutral" title="What this result means">
        {result.disclaimer}
      </Callout>
    </div>
  );
}
