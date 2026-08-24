import {
  isAppealPending,
  type AppealState,
  type DecisionOutcome,
} from '@safecheck/shared';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE PUBLICATION GATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The single place in SafeCheck that decides whether anything about a person may
 * be disclosed to someone who searched for them. Everything else — the search
 * endpoint, the seed data, the admin tooling — must ask this module.
 *
 * The product requirement it implements: *never* label a person based on an
 * accusation. An allegation therefore has to survive the entire due-process
 * chain before a stranger can see it, and the chain is expressed here as a
 * conjunction of independent conditions, each of which can veto disclosure.
 *
 * Design notes worth preserving if you refactor:
 *
 *  1. PURE. No database, no clock, no config reads. `now` and the policy window
 *     are parameters. That makes every branch trivially testable, and the tests
 *     in visibility.test.ts assert each veto *individually* rather than only in
 *     aggregate — an aggregate-only test passes even if a condition is dropped.
 *
 *  2. FAIL CLOSED. The function returns a list of reasons rather than a boolean
 *     so a caller can log why something stayed hidden. Any unknown or malformed
 *     input yields "not disclosable"; there is no default-allow path.
 *
 *  3. THE QUERY IS ONLY AN OPTIMISATION. `publishableCandidateFilter()` below
 *     narrows Mongo candidates, but the search service still runs every
 *     candidate through `evaluateDisclosure()` before disclosing it. If the
 *     filter and the gate ever disagree, the gate wins and the filter is merely
 *     wasteful — not unsafe. Never disclose straight from a query result.
 */

export type DisclosureBlockReason =
  | 'outcome_not_upheld'
  | 'not_marked_publishable'
  | 'decision_vacated'
  | 'report_withdrawn'
  | 'subject_not_notified'
  | 'appeal_window_open'
  | 'appeal_pending';

export interface DisclosureInputs {
  /** Decision outcome. Only 'upheld' is ever eligible. */
  outcome: DecisionOutcome;
  /** Explicit moderator act, separate from issuing the decision. */
  publishable: boolean;
  /** Non-null if an appeal vacated the decision. */
  vacatedAt: Date | null;
  /** Non-null if the reporter withdrew the report. */
  reportWithdrawnAt: Date | null;
  /** When the subject was told a decision concerns them. Null = never told. */
  subjectNotifiedAt: Date | null;
  /** The nominal window end recorded on the decision. */
  appealWindowEndsAt: Date;
  /** States of every appeal against this decision. */
  appealStates: readonly AppealState[];
  /** Policy window length, used to give late-notified subjects a full window. */
  appealWindowDays: number;
  now: Date;
}

export type DisclosureVerdict =
  | { disclosable: true; effectiveAppealDeadline: Date }
  | { disclosable: false; reasons: DisclosureBlockReason[]; effectiveAppealDeadline: Date | null };

const MS_PER_DAY = 86_400_000;

/**
 * The deadline that actually matters.
 *
 * A subject notified two days before a nominal 14-day window closes has had two
 * days to appeal, not fourteen. Publishing on the nominal date would let sloppy
 * or adversarial notification timing strip someone's right of reply. So the
 * effective deadline is whichever is later: the recorded window end, or a full
 * window measured from the moment the subject was actually notified.
 */
export function effectiveAppealDeadline(
  appealWindowEndsAt: Date,
  subjectNotifiedAt: Date,
  appealWindowDays: number,
): Date {
  const fromNotification = new Date(subjectNotifiedAt.getTime() + appealWindowDays * MS_PER_DAY);
  return fromNotification > appealWindowEndsAt ? fromNotification : appealWindowEndsAt;
}

/**
 * Evaluate every condition and collect all failures. We deliberately do not
 * short-circuit: knowing all the reasons is more useful for audit and for
 * moderator-facing explanations than knowing only the first.
 */
export function evaluateDisclosure(input: DisclosureInputs): DisclosureVerdict {
  const reasons: DisclosureBlockReason[] = [];

  if (input.outcome !== 'upheld') reasons.push('outcome_not_upheld');
  if (!input.publishable) reasons.push('not_marked_publishable');
  if (input.vacatedAt !== null) reasons.push('decision_vacated');
  if (input.reportWithdrawnAt !== null) reasons.push('report_withdrawn');
  if (input.appealStates.some(isAppealPending)) reasons.push('appeal_pending');

  // Notification is a precondition for the deadline calculation, so handle the
  // missing case separately and bail out of any time-based reasoning.
  if (input.subjectNotifiedAt === null) {
    reasons.push('subject_not_notified');
    return { disclosable: false, reasons, effectiveAppealDeadline: null };
  }

  const deadline = effectiveAppealDeadline(
    input.appealWindowEndsAt,
    input.subjectNotifiedAt,
    input.appealWindowDays,
  );
  if (input.now < deadline) reasons.push('appeal_window_open');

  return reasons.length === 0
    ? { disclosable: true, effectiveAppealDeadline: deadline }
    : { disclosable: false, reasons, effectiveAppealDeadline: deadline };
}

/** Convenience wrapper when the caller only needs the boolean. */
export function isDisclosable(input: DisclosureInputs): boolean {
  return evaluateDisclosure(input).disclosable;
}

/**
 * Mongo filter narrowing Decision documents to *plausible* candidates.
 *
 * READ THIS BEFORE USING IT: this is a performance pre-filter, nothing more. It
 * cannot express the appeal-pending join or the notification-relative deadline,
 * so it is necessarily weaker than the gate. Callers must still pass every
 * candidate through `evaluateDisclosure()`. See the search service for the
 * intended pattern.
 */
export function publishableCandidateFilter(now: Date): Record<string, unknown> {
  return {
    outcome: 'upheld',
    publishable: true,
    vacatedAt: null,
    appealWindowEndsAt: { $lte: now },
  };
}

/** Human-readable explanations, for moderator UI and audit metadata. */
export const BLOCK_REASON_TEXT: Record<DisclosureBlockReason, string> = {
  outcome_not_upheld: 'The decision did not uphold the report.',
  not_marked_publishable: 'No moderator has approved this record for publication.',
  decision_vacated: 'The decision was vacated on appeal.',
  report_withdrawn: 'The reporter withdrew the report.',
  subject_not_notified: 'The subject has not been notified of the decision.',
  appeal_window_open: 'The appeal window has not closed yet.',
  appeal_pending: 'An appeal is currently pending.',
};
