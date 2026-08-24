import { describe, expect, it } from 'vitest';
import type { AppealState } from '@safecheck/shared';
import {
  evaluateDisclosure,
  effectiveAppealDeadline,
  isDisclosable,
  type DisclosureInputs,
} from './visibility.js';

/**
 * The gate is the product's central safety promise, so these tests assert each
 * veto INDIVIDUALLY. A single "happy path plus one blocked case" test would
 * still pass if someone deleted a condition; testing every reason in isolation
 * means dropping any one check turns a test red.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-06-01T00:00:00.000Z');

/** A fully-disclosable baseline. Each test perturbs exactly one field. */
function baseline(overrides: Partial<DisclosureInputs> = {}): DisclosureInputs {
  return {
    outcome: 'upheld',
    publishable: true,
    vacatedAt: null,
    reportWithdrawnAt: null,
    subjectNotifiedAt: new Date(NOW.getTime() - 30 * DAY), // notified long ago
    appealWindowEndsAt: new Date(NOW.getTime() - 1 * DAY), // window already closed
    appealStates: [],
    appealWindowDays: 14,
    now: NOW,
    ...overrides,
  };
}

describe('evaluateDisclosure — the happy path', () => {
  it('discloses when every condition is satisfied', () => {
    const verdict = evaluateDisclosure(baseline());
    expect(verdict.disclosable).toBe(true);
    expect(isDisclosable(baseline())).toBe(true);
  });
});

describe('evaluateDisclosure — each veto in isolation', () => {
  it('blocks a non-upheld outcome', () => {
    const v = evaluateDisclosure(baseline({ outcome: 'not_upheld' }));
    expect(v.disclosable).toBe(false);
    expect(v.disclosable ? [] : v.reasons).toContain('outcome_not_upheld');
  });

  it.each(['insufficient_evidence', 'out_of_scope', 'referred'] as const)(
    'blocks outcome=%s',
    (outcome) => {
      expect(isDisclosable(baseline({ outcome }))).toBe(false);
    },
  );

  it('blocks when not marked publishable', () => {
    const v = evaluateDisclosure(baseline({ publishable: false }));
    expect(v.disclosable).toBe(false);
    expect(v.disclosable ? [] : v.reasons).toContain('not_marked_publishable');
  });

  it('blocks a vacated decision', () => {
    const v = evaluateDisclosure(baseline({ vacatedAt: new Date(NOW.getTime() - DAY) }));
    expect(v.disclosable ? [] : v.reasons).toContain('decision_vacated');
  });

  it('blocks a withdrawn report', () => {
    const v = evaluateDisclosure(baseline({ reportWithdrawnAt: new Date(NOW.getTime() - DAY) }));
    expect(v.disclosable ? [] : v.reasons).toContain('report_withdrawn');
  });

  it('blocks when the subject was never notified', () => {
    const v = evaluateDisclosure(baseline({ subjectNotifiedAt: null }));
    expect(v.disclosable).toBe(false);
    expect(v.disclosable ? [] : v.reasons).toContain('subject_not_notified');
    // With no notification we cannot compute a deadline.
    expect(v.disclosable ? null : v.effectiveAppealDeadline).toBeNull();
  });

  it('blocks while the appeal window is still open', () => {
    const v = evaluateDisclosure(
      baseline({ appealWindowEndsAt: new Date(NOW.getTime() + 5 * DAY) }),
    );
    expect(v.disclosable ? [] : v.reasons).toContain('appeal_window_open');
  });

  it.each<AppealState>(['filed', 'under_review'])('blocks while an appeal is %s', (state) => {
    const v = evaluateDisclosure(baseline({ appealStates: [state] }));
    expect(v.disclosable).toBe(false);
    expect(v.disclosable ? [] : v.reasons).toContain('appeal_pending');
  });

  it.each<AppealState>(['granted', 'denied', 'withdrawn'])(
    'does not block for a resolved appeal (%s)',
    (state) => {
      // A denied/withdrawn appeal shouldn't keep a record hidden forever; a
      // granted one is expected to have vacated the decision separately.
      const v = evaluateDisclosure(baseline({ appealStates: [state] }));
      expect(v.disclosable ? [] : v.reasons).not.toContain('appeal_pending');
    },
  );
});

describe('evaluateDisclosure — reasons accumulate, never short-circuit', () => {
  it('reports every failing condition at once', () => {
    const v = evaluateDisclosure(
      baseline({
        outcome: 'not_upheld',
        publishable: false,
        appealStates: ['filed'],
      }),
    );
    expect(v.disclosable).toBe(false);
    const reasons = v.disclosable ? [] : v.reasons;
    expect(reasons).toEqual(
      expect.arrayContaining(['outcome_not_upheld', 'not_marked_publishable', 'appeal_pending']),
    );
  });
});

describe('effectiveAppealDeadline — late notification extends the window', () => {
  it('uses the recorded window end when the subject was notified early', () => {
    const windowEnd = new Date(NOW.getTime() - DAY);
    const notified = new Date(NOW.getTime() - 30 * DAY);
    expect(effectiveAppealDeadline(windowEnd, notified, 14).getTime()).toBe(windowEnd.getTime());
  });

  it('extends to a full window from a late notification', () => {
    // Subject notified only "now", with a window that nominally already closed.
    const windowEnd = new Date(NOW.getTime() - DAY);
    const notified = NOW;
    const deadline = effectiveAppealDeadline(windowEnd, notified, 14);
    expect(deadline.getTime()).toBe(NOW.getTime() + 14 * DAY);
  });

  it('keeps a record hidden when notification was too recent for a full window', () => {
    // Notified 2 days ago, nominal window closed, but policy grants 14 days.
    const v = evaluateDisclosure(
      baseline({
        subjectNotifiedAt: new Date(NOW.getTime() - 2 * DAY),
        appealWindowEndsAt: new Date(NOW.getTime() - DAY),
      }),
    );
    expect(v.disclosable).toBe(false);
    expect(v.disclosable ? [] : v.reasons).toContain('appeal_window_open');
  });
});
