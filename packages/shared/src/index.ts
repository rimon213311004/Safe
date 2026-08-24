/**
 * @safecheck/shared — the single source of truth for domain enums and API
 * contracts. Both the Express API and the Next.js client import from here, so
 * validation rules, TypeScript types, and form resolvers can never drift.
 */

export * from './enums.js';

export * as authSchemas from './schemas/auth.js';
export * as reportSchemas from './schemas/report.js';
export * as evidenceSchemas from './schemas/evidence.js';
export * as moderationSchemas from './schemas/moderation.js';
export * as appealSchemas from './schemas/appeal.js';
export * as searchSchemas from './schemas/search.js';
export * as notificationSchemas from './schemas/notification.js';
export * as commonSchemas from './schemas/common.js';

/* Frequently-used types re-exported flat for ergonomics. */
export type {
  AuthChallenge,
  AuthTokens,
  AuthUser,
  LoginInput,
  RegisterInput,
  VerifyEmailInput,
} from './schemas/auth.js';
export type {
  CreateReportInput,
  ListReportsQuery,
  ReportDetail,
  ReportSummary,
  SubjectIdentifierInput,
  UpdateReportDraftInput,
  WithdrawReportInput,
} from './schemas/report.js';
export type {
  EvidenceAccessGrant,
  EvidenceItem,
  InitiateEvidenceUploadInput,
} from './schemas/evidence.js';
export type {
  AddCaseNoteInput,
  AssignCaseInput,
  CaseDetail,
  CaseSummary,
  IssueDecisionInput,
  ListQueueQuery,
  SetCasePriorityInput,
  SetCaseStateInput,
  SetDecisionPublishableInput,
} from './schemas/moderation.js';
export type { AppealDetail, AppealSummary, FileAppealInput, ResolveAppealInput } from './schemas/appeal.js';
export type { PublishedRecord, SearchInput, SearchResult } from './schemas/search.js';
export type {
  ListNotificationsQuery,
  MarkNotificationsReadInput,
  NotificationItem,
} from './schemas/notification.js';
export type { ApiErrorBody, Pagination } from './schemas/common.js';

export { SEARCH_DISCLAIMER } from './schemas/search.js';
export { ALLOWED_EVIDENCE_MIME, MAX_EVIDENCE_BYTES } from './schemas/evidence.js';
