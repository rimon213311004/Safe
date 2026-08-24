import type { ReactNode } from 'react';

/**
 * Presentational primitives. No state, no data fetching — every one of these is
 * safe to render from a server or a client component.
 *
 * The set is small on purpose. Anything used once lives in the screen that uses
 * it; only shapes that repeat across screens are lifted here.
 */

/* -------------------------------------------------------------------- fields */

interface FieldProps {
  label: string;
  htmlFor?: string;
  /** Guidance shown before the user gets it wrong. */
  hint?: ReactNode;
  /** Field-level messages, from the client's own validation or the API's 422. */
  error?: string[] | string | null;
  children: ReactNode;
  /** Rendered opposite the label — a character counter, an optional marker. */
  aside?: ReactNode;
}

export function Field({ label, htmlFor, hint, error, children, aside }: FieldProps) {
  const messages = typeof error === 'string' ? [error] : (error ?? []);
  return (
    <div className="field">
      <div className="row between" style={{ gap: 8 }}>
        <label className="field-label" htmlFor={htmlFor}>
          {label}
        </label>
        {aside}
      </div>
      {children}
      {hint && !messages.length ? <span className="hint">{hint}</span> : null}
      {messages.map((message) => (
        <span className="err" key={message}>
          {message}
        </span>
      ))}
    </div>
  );
}

/** Live character count for the bounded narrative fields the API enforces. */
export function CharCount({ value, min, max }: { value: string; min?: number; max: number }) {
  const length = value.trim().length;
  const short = min !== undefined && length > 0 && length < min;
  return (
    <span className={`counter${length > max || short ? ' over' : ''}`}>
      {short ? `${length} / ${min} minimum` : `${length} / ${max}`}
    </span>
  );
}

/* ------------------------------------------------------------------ feedback */

export type Tone = 'info' | 'warn' | 'danger' | 'success' | 'neutral';

export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`callout ${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      {title ? <span className="callout-title">{title}</span> : null}
      {children}
    </div>
  );
}

/** The top-level error from a submitted form. Renders nothing when there is none. */
export function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return <Callout tone="danger">{error}</Callout>;
}

export type BadgeTone = 'draft' | 'open' | 'active' | 'done' | 'closed' | 'alert' | 'grave';

export function Badge({ tone = 'draft', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-block" role="status">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-title">{title}</span>
      {children ? <span>{children}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ surfaces */

export function Card({
  title,
  actions,
  children,
  flush,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className={`card${flush ? ' flush' : ''}`}>
      {title || actions ? (
        <div className="card-head" style={flush ? { padding: '18px 18px 0' } : undefined}>
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function PageHead({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="row between top" style={{ marginBottom: 20 }}>
      <div className="page-head">
        <h1>{title}</h1>
        {children ? <p className="lede">{children}</p> : null}
      </div>
      {actions}
    </div>
  );
}

/** A definition list. Entries with a nullish value are dropped, not shown blank. */
export function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  const visible = items.filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (!visible.length) return null;
  return (
    <dl className="dl">
      {visible.map(([term, value]) => (
        <div key={term} style={{ display: 'contents' }}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------- buttons */

export function SubmitButton({
  pending,
  children,
  variant = 'primary',
  disabled,
  block,
}: {
  pending: boolean;
  children: ReactNode;
  variant?: 'primary' | 'danger' | 'secondary';
  disabled?: boolean;
  block?: boolean;
}) {
  const className = ['btn', variant === 'secondary' ? '' : variant, block ? 'block' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type="submit" className={className} disabled={pending || disabled}>
      {pending ? <Spinner /> : null}
      {children}
    </button>
  );
}

/** A set of mutually exclusive filters. `null` is the "everything" option. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T | null; label: string }>;
  value: T | null;
  onChange: (next: T | null) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value ?? '__all'}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
