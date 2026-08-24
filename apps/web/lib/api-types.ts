import type {
  AppealParty,
  AppealState,
  AuthUser,
  CasePriority,
  CaseState,
  DecisionOutcome,
  NotificationItem,
  ReportCategory,
} from '@safecheck/shared';

/**
 * Response shapes as the API actually sends them.
 *
 * `@safecheck/shared` defines the *contract* — the fields both sides agree on —
 * and the serialisers in the API return a superset of it in a few places
 * (`decision.id`, `case.overdue`, `report.subjectNotifiedAt`). Rather than cast
 * those away at every call site, the extra fields are declared here and marked
 * as such. If one of them disappears from the API, this file is the single place
 * that has to change.
 *
 * Input types are NOT redeclared. Every form validates with the shared Zod schema
 * itself, so a request body can never drift from what the server will accept.
 */

export interface AuthPayload {
  accessToken: string;
  accessTokenExpiresAt: string;
  user: AuthUser;
}

/* --------------------------------------------------------------- reports */

export interface ReportSummaryDto {
  id: string;
  category: string;
  status: string;
  subjectLabel: string;
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PartyDecisionDto {
  outcome: string;
  rationale: string;
  issuedAt: string;
  appealWindowEndsAt: string;
  /** False once an appeal exists or the window has closed. */
  canAppeal: boolean;
}

export interface EvidenceDto {
  id: string;
  reportId: string;
  filename: string;
  mime: string;
  kind: string;
  sizeBytes: number;
  caption?: string;
  scanStatus: string;
  /** Only `true` items can be fetched; anything else is still being scanned. */
  releasable: boolean;
  createdAt: string;
}

export interface ReportDetailDto extends ReportSummaryDto {
  description: string;
  incidentAt?: string;
  location?: string;
  evidenceIds: string[];
  decision: PartyDecisionDto | null;
}

/* --------------------------------------------------------------- appeals */

export interface AppealSummaryDto {
  id: string;
  reportId: string;
  party: AppealParty;
  state: AppealState;
  filedAt: string;
  resolvedAt: string | null;
}

export interface AppealDetailDto extends AppealSummaryDto {
  grounds: string;
  resolution: { decision: 'granted' | 'denied'; rationale: string; effect: string | null } | null;
}

/** The moderator queue carries the issuing moderator so the UI can hide conflicts. */
export interface PendingAppealDto extends AppealSummaryDto {
  grounds: string;
  decisionIssuedBy: string | null;
  decisionOutcome: DecisionOutcome | null;
  reviewerId: string | null;
}

/* ------------------------------------------------------------ moderation */

export interface CaseSummaryDto {
  id: string;
  reportId: string;
  category: string;
  /** Beyond the shared contract: lets the queue show report and case state together. */
  reportStatus: string;
  state: CaseState;
  priority: CasePriority;
  grave: boolean;
  assignedTo: string | null;
  slaDueAt: string | null;
  /** Beyond the shared contract. A reporting signal, never an escalation. */
  overdue: boolean;
  createdAt: string;
}

export interface CaseDecisionDto {
  /** Beyond the shared contract, and required: the publication endpoint is keyed by it. */
  id: string;
  outcome: DecisionOutcome;
  rationale: string;
  publishable: boolean;
  issuedBy: string;
  publishableSetBy: string | null;
  appealWindowEndsAt: string;
  issuedAt: string;
  vacatedAt: string | null;
}

export interface CaseDetailDto extends Omit<CaseSummaryDto, 'reportStatus' | 'overdue'> {
  report: {
    category: ReportCategory;
    description: string;
    incidentAt?: string;
    location?: string;
    /** A human label only. The API never sends a subject identifier or its hash. */
    subjectLabel: string;
    subjectNotifiedAt: string | null;
    reporterId: string;
    status: string;
  };
  evidence: Array<{
    id: string;
    filename: string;
    kind: string;
    scanStatus: string;
    releasable: boolean;
  }>;
  notes: Array<{ id: string; authorId: string; body: string; createdAt: string }>;
  decision: CaseDecisionDto | null;
}

/**
 * The publication gate's own verdict, in plain language.
 *
 * `reasons` is already human-readable text from the API — every reason a record
 * is still not disclosable, not just the first one. An empty array with
 * `disclosable: false` should never happen; if it does, treat it as blocked.
 */
export interface DisclosureDto {
  disclosable: boolean;
  reasons: string[];
  effectiveAppealDeadline: string | null;
}

export interface NotificationsPage {
  notifications: NotificationItem[];
  nextCursor: string | null;
  unread: number;
}
