/**
 * Domain enumerations shared by the API and the web client.
 *
 * Each is a frozen tuple so it can be fed straight to `z.enum(...)` and still
 * yield a narrow union type. Import the tuple for validation, the type for
 * signatures.
 */

/* ------------------------------------------------------------------ people */

export const ROLES = ['user', 'moderator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Identifiers a subject may be looked up by. Stored only as HMAC hashes. */
export const IDENTIFIER_TYPES = ['email', 'phone'] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

export const IDENTITY_VERIFICATION_STATUSES = [
  'unverified',
  'pending',
  'verified',
  'rejected',
] as const;
export type IdentityVerificationStatus = (typeof IDENTITY_VERIFICATION_STATUSES)[number];

/* ----------------------------------------------------------------- reports */

export const REPORT_CATEGORIES = [
  'harassment',
  'stalking',
  'threats',
  'fraud',
  'sexual_harassment',
  'unwanted_contact',
  'violence',
  'impersonation',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * Categories treated as grave allegations. These carry the heaviest
 * consequences for the accused if mishandled, so the service layer applies
 * heightened handling: two-moderator review before any decision may be marked
 * publishable, and a non-shortenable appeal window.
 *
 * This list is deliberately conservative. Adding to it tightens handling;
 * removing from it loosens it — treat removals as a policy change, not a
 * refactor.
 */
export const GRAVE_CATEGORIES = [
  'sexual_harassment',
  'violence',
  'threats',
  'stalking',
] as const satisfies readonly ReportCategory[];
export type GraveCategory = (typeof GRAVE_CATEGORIES)[number];

export function isGraveCategory(category: ReportCategory): category is GraveCategory {
  return (GRAVE_CATEGORIES as readonly ReportCategory[]).includes(category);
}

/**
 * Report lifecycle. A report is never "public" — publication is a property of
 * a Decision, never of a Report. See domain/visibility.ts in the API.
 */
export const REPORT_STATUSES = [
  'draft',
  'submitted',
  'triage',
  'under_review',
  'awaiting_evidence',
  'decided',
  'withdrawn',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Legal transitions. Enforced in the report service; no ad-hoc status writes. */
export const REPORT_STATUS_TRANSITIONS: Readonly<Record<ReportStatus, readonly ReportStatus[]>> =
  Object.freeze({
    draft: ['submitted', 'withdrawn'],
    submitted: ['triage', 'withdrawn'],
    triage: ['under_review', 'awaiting_evidence', 'decided', 'withdrawn'],
    under_review: ['awaiting_evidence', 'decided', 'withdrawn'],
    awaiting_evidence: ['under_review', 'decided', 'withdrawn'],
    /**
     * `decided` is terminal for every ordinary path. The single exception exists
     * because a granted appeal that vacates a decision has to return the report
     * to review — otherwise a vacated decision would leave the report frozen in a
     * state whose decision no longer stands. Only the appeal service uses this
     * edge; nothing else may move a report out of `decided`.
     */
    decided: ['under_review'],
    withdrawn: [],
  });

export function canTransitionReport(from: ReportStatus, to: ReportStatus): boolean {
  return REPORT_STATUS_TRANSITIONS[from].includes(to);
}

/* -------------------------------------------------------------- moderation */

export const CASE_STATES = [
  'unassigned',
  'assigned',
  'investigating',
  'awaiting_decision',
  'closed',
] as const;
export type CaseState = (typeof CASE_STATES)[number];

export const CASE_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

/**
 * Decision outcomes. Only `upheld` can ever become searchable, and only after
 * the full publication gate passes. Every other outcome is terminal and
 * private to the parties.
 */
export const DECISION_OUTCOMES = [
  'upheld',
  'not_upheld',
  'insufficient_evidence',
  'out_of_scope',
  'referred',
] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

/* ----------------------------------------------------------------- appeals */

export const APPEAL_STATES = [
  'filed',
  'under_review',
  'granted',
  'denied',
  'withdrawn',
] as const;
export type AppealState = (typeof APPEAL_STATES)[number];

/** Appeal states that keep a decision unpublishable while unresolved. */
export const APPEAL_PENDING_STATES = ['filed', 'under_review'] as const satisfies
  readonly AppealState[];

export function isAppealPending(state: AppealState): boolean {
  return (APPEAL_PENDING_STATES as readonly AppealState[]).includes(state);
}

/** Who may appeal a decision. */
export const APPEAL_PARTIES = ['reporter', 'subject'] as const;
export type AppealParty = (typeof APPEAL_PARTIES)[number];

/* ---------------------------------------------------------------- evidence */

export const EVIDENCE_SCAN_STATUSES = [
  'pending',
  'clean',
  'flagged',
  'quarantined',
  'failed',
] as const;
export type EvidenceScanStatus = (typeof EVIDENCE_SCAN_STATUSES)[number];

/** Only these statuses permit an evidence item to be fetched by a party. */
export const EVIDENCE_RELEASABLE_STATUSES = ['clean'] as const satisfies
  readonly EvidenceScanStatus[];

export const EVIDENCE_KINDS = ['image', 'document', 'audio', 'video', 'other'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/* ----------------------------------------------------------- notifications */

export const NOTIFICATION_TYPES = [
  'report.submitted',
  'report.status_changed',
  'evidence.scan_completed',
  'case.assigned',
  'decision.issued',
  'decision.published',
  'appeal.filed',
  'appeal.resolved',
  'subject.notified',
  'account.security',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/* ------------------------------------------------------------------- audit */

/**
 * Audit actions. The log is append-only; every entry that touches a person's
 * record or exposes evidence must be represented here.
 */
export const AUDIT_ACTIONS = [
  'account.registered',
  'account.email_verified',
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.token_reuse_detected',
  'auth.password_changed',
  'report.created',
  'report.submitted',
  'report.status_changed',
  'report.withdrawn',
  'evidence.uploaded',
  'evidence.accessed',
  'evidence.purged',
  'case.assigned',
  'case.note_added',
  'case.priority_set',
  'case.state_changed',
  'decision.issued',
  'decision.publishable_set',
  'decision.unpublished',
  'appeal.filed',
  'appeal.resolved',
  'search.performed',
  'search.record_disclosed',
  'subject.notified',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/* --------------------------------------------------------- realtime events */

export const SOCKET_EVENTS = [
  'report.status_changed',
  'case.assigned',
  'decision.issued',
  'appeal.updated',
  'notification.created',
] as const;
export type SocketEvent = (typeof SOCKET_EVENTS)[number];
