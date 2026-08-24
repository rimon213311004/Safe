import type {
  AppealState,
  CasePriority,
  CaseState,
  DecisionOutcome,
  NotificationType,
  ReportCategory,
  ReportStatus,
} from '@safecheck/shared';

/**
 * Human wording for every enum the user can see, and the formatters for dates
 * and sizes.
 *
 * Two of these carry real weight rather than being cosmetic:
 *
 *  • DECISION_OUTCOME_MEANING spells out what an outcome does and does not
 *    assert. "Not upheld" is not "innocent" and "insufficient evidence" is not
 *    "didn't happen"; a party reading their own outcome deserves that stated
 *    rather than inferred.
 *
 *  • formatMonth exists because search results carry month precision only. Never
 *    reformat a `decidedMonth` through a date parser — "2025-11" parsed as a date
 *    becomes the 1st of the month in some local timezone, which invents a day the
 *    API deliberately withheld.
 */

const FALLBACK = (value: string): string =>
  value.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/* ------------------------------------------------------------------ reports */

const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  harassment: 'Harassment',
  stalking: 'Stalking',
  threats: 'Threats',
  fraud: 'Fraud or financial abuse',
  sexual_harassment: 'Sexual harassment',
  unwanted_contact: 'Unwanted contact',
  violence: 'Violence',
  impersonation: 'Impersonation',
  other: 'Something else',
};

export function categoryLabel(category: string): string {
  return REPORT_CATEGORY_LABELS[category as ReportCategory] ?? FALLBACK(category);
}

const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  triage: 'In triage',
  under_review: 'Under review',
  awaiting_evidence: 'Awaiting evidence',
  decided: 'Decided',
  withdrawn: 'Withdrawn',
};

/** What each status means for the reporter, in the second person. */
const REPORT_STATUS_MEANING: Record<ReportStatus, string> = {
  draft: 'Not submitted yet. Only you can see this.',
  submitted: 'Received. It will be picked up by a moderator shortly.',
  triage: 'A moderator has opened your report and is assessing it.',
  under_review: 'Being investigated. You will be notified when there is an outcome.',
  awaiting_evidence: 'A moderator is waiting on further evidence before deciding.',
  decided: 'An outcome has been recorded. See the decision below.',
  withdrawn: 'You withdrew this report. It is no longer being reviewed.',
};

export function reportStatusLabel(status: string): string {
  return REPORT_STATUS_LABELS[status as ReportStatus] ?? FALLBACK(status);
}

export function reportStatusMeaning(status: string): string | null {
  return REPORT_STATUS_MEANING[status as ReportStatus] ?? null;
}

/** Drives the badge colour. `open` is neutral-positive, `closed` is grey. */
export function reportStatusTone(status: string): 'draft' | 'open' | 'active' | 'done' | 'closed' {
  switch (status as ReportStatus) {
    case 'draft':
      return 'draft';
    case 'submitted':
    case 'triage':
      return 'open';
    case 'under_review':
    case 'awaiting_evidence':
      return 'active';
    case 'decided':
      return 'done';
    default:
      return 'closed';
  }
}

/* --------------------------------------------------------------- moderation */

const CASE_STATE_LABELS: Record<CaseState, string> = {
  unassigned: 'Unassigned',
  assigned: 'Assigned',
  investigating: 'Investigating',
  awaiting_decision: 'Awaiting decision',
  closed: 'Closed',
};

export function caseStateLabel(state: string): string {
  return CASE_STATE_LABELS[state as CaseState] ?? FALLBACK(state);
}

const CASE_PRIORITY_LABELS: Record<CasePriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export function priorityLabel(priority: string): string {
  return CASE_PRIORITY_LABELS[priority as CasePriority] ?? FALLBACK(priority);
}

const DECISION_OUTCOME_LABELS: Record<DecisionOutcome, string> = {
  upheld: 'Upheld',
  not_upheld: 'Not upheld',
  insufficient_evidence: 'Insufficient evidence',
  out_of_scope: 'Out of scope',
  referred: 'Referred onward',
};

export function outcomeLabel(outcome: string): string {
  return DECISION_OUTCOME_LABELS[outcome as DecisionOutcome] ?? FALLBACK(outcome);
}

/**
 * What the outcome asserts — written for the parties, who will otherwise read
 * more into it than it says. Only `upheld` can ever become searchable, and only
 * after the full publication gate passes.
 */
const DECISION_OUTCOME_MEANING: Record<DecisionOutcome, string> = {
  upheld:
    'The account in the report was accepted on review. This is the only outcome that can ever appear in search, and only after the appeal window closes.',
  not_upheld:
    'The report was not accepted on review. Nothing about it will ever appear in search.',
  insufficient_evidence:
    'There was not enough evidence to decide either way. This is not a finding that the incident did not happen, and nothing will appear in search.',
  out_of_scope:
    'This is not something SafeCheck can adjudicate. Nothing will appear in search.',
  referred:
    'The matter was passed to a body better placed to handle it. Nothing will appear in search.',
};

export function outcomeMeaning(outcome: string): string | null {
  return DECISION_OUTCOME_MEANING[outcome as DecisionOutcome] ?? null;
}

export function outcomeTone(outcome: string): 'done' | 'closed' {
  return outcome === 'upheld' ? 'done' : 'closed';
}

/* ------------------------------------------------------------------ appeals */

const APPEAL_STATE_LABELS: Record<AppealState, string> = {
  filed: 'Filed',
  under_review: 'Under review',
  granted: 'Granted',
  denied: 'Denied',
  withdrawn: 'Withdrawn',
};

export function appealStateLabel(state: string): string {
  return APPEAL_STATE_LABELS[state as AppealState] ?? FALLBACK(state);
}

export function appealPartyLabel(party: string): string {
  return party === 'subject' ? 'The person reported' : 'The reporter';
}

/* ------------------------------------------------------------ notifications */

const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  'report.submitted': 'Report submitted',
  'report.status_changed': 'Report updated',
  'evidence.scan_completed': 'Evidence checked',
  'case.assigned': 'Case assigned',
  'decision.issued': 'Decision issued',
  'decision.published': 'Record published',
  'appeal.filed': 'Appeal filed',
  'appeal.resolved': 'Appeal resolved',
  'subject.notified': 'Subject notified',
  'account.security': 'Account security',
};

export function notificationLabel(type: string): string {
  return NOTIFICATION_LABELS[type as NotificationType] ?? FALLBACK(type);
}

/* ----------------------------------------------------------------- date/size */

/**
 * Dates are rendered in the reader's own locale and timezone. Fixed to UTC only
 * where the API's value is UTC-derived by contract — see formatMonth.
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Render a "YYYY-MM" from a search result.
 *
 * Formatted from its parts rather than parsed as a date on purpose: parsing
 * "2025-11" yields a timestamp, and a timestamp shifted into the reader's
 * timezone can land in October — a precision the API withheld and a month it
 * never said.
 */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatMonth(value: string | null | undefined): string {
  if (!value) return '—';
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  const month = MONTH_NAMES[Number(match[2]) - 1];
  return month ? `${month} ${match[1]}` : value;
}

/** "in 12 days" / "3 days ago" / "today", for appeal windows and SLAs. */
export function relativeDays(iso: string | null | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '—';
  const days = Math.round((at - Date.now()) / 86_400_000);
  if (days === 0) return 'today';
  if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}`;
  const ago = Math.abs(days);
  return `${ago} day${ago === 1 ? '' : 's'} ago`;
}

/* ----------------------------------------------------------- form <-> instant */

/**
 * Turn a `datetime-local` value into the ISO instant the contract wants.
 *
 * The input gives "2026-08-25T14:30" with no zone. Reading it in the user's own
 * timezone is the right interpretation — they typed a wall-clock time where they
 * were standing — and `new Date(...)` on that format does exactly that.
 */
export function toInstant(local: string): string | undefined {
  if (!local) return undefined;
  const at = new Date(local);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** The inverse, for prefilling a `datetime-local` from a stored instant. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Scan status wording. Evidence is only fetchable once it reads `clean`. */
export function scanStatusLabel(status: string, releasable: boolean): string {
  if (releasable) return 'Checked';
  switch (status) {
    case 'pending':
      return 'Being checked';
    case 'flagged':
      return 'Flagged for review';
    case 'quarantined':
      return 'Quarantined';
    case 'failed':
      return 'Check failed';
    default:
      return FALLBACK(status);
  }
}
