import { z } from 'zod';
import {
  CASE_PRIORITIES,
  CASE_STATES,
  DECISION_OUTCOMES,
} from '../enums.js';
import { narrative, objectId } from './common.js';

/**
 * Moderation surface. These endpoints are moderator/admin only. The shapes here
 * intentionally separate what a moderator writes (notes, decisions) from what a
 * party ever sees — internal notes never appear in any party-facing schema.
 */

export const caseState = z.enum(CASE_STATES);
export const casePriority = z.enum(CASE_PRIORITIES);
export const decisionOutcome = z.enum(DECISION_OUTCOMES);

export const listQueueQuery = z.object({
  state: caseState.optional(),
  priority: casePriority.optional(),
  assignedToMe: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListQueueQuery = z.infer<typeof listQueueQuery>;

export const assignCaseInput = z.object({
  /** Omit to self-assign. Admins may pass another moderator's id. */
  moderatorId: objectId.optional(),
});
export type AssignCaseInput = z.infer<typeof assignCaseInput>;

export const addCaseNoteInput = z.object({
  body: narrative(1, 4000),
  /** Internal notes are the default and never leave the moderation surface. */
  visibility: z.enum(['internal']).default('internal'),
});
export type AddCaseNoteInput = z.infer<typeof addCaseNoteInput>;

export const setCasePriorityInput = z.object({
  priority: casePriority,
});
export type SetCasePriorityInput = z.infer<typeof setCasePriorityInput>;

/**
 * Moving a case through the workflow. `unassigned` is absent deliberately — a
 * case is only unassigned before anyone has touched it, and un-assigning would
 * drop accountability for work already done. Reassign instead.
 */
export const setCaseStateInput = z.object({
  state: z.enum(['assigned', 'investigating', 'awaiting_decision', 'closed']),
});
export type SetCaseStateInput = z.infer<typeof setCaseStateInput>;

/**
 * Issuing a decision. This does NOT publish anything — `publishable` is set by a
 * separate action (setDecisionPublishable) and, for grave categories, requires
 * a second moderator. Rationale is shown to both parties, so it must be written
 * for them, not as internal shorthand.
 */
export const issueDecisionInput = z.object({
  outcome: decisionOutcome,
  rationale: narrative(20, 4000),
  /**
   * Reporter and subject are notified when a decision is issued. This flag lets
   * a moderator confirm they've considered subject notification; it must be
   * true to issue (the notification itself is sent by the service).
   */
  acknowledgeSubjectNotification: z.literal(true, {
    error: 'Confirm the subject will be notified of this decision',
  }),
});
export type IssueDecisionInput = z.infer<typeof issueDecisionInput>;

/**
 * Marking a decision publishable. Separate from issuing on purpose: deciding and
 * publishing must never be the same click. Only `upheld` decisions can be made
 * publishable, and only this flag (plus the appeal window and notification)
 * lets a record ever surface in search.
 */
export const setDecisionPublishableInput = z.object({
  publishable: z.boolean(),
  /** Required when setting publishable=true; the reviewing moderator's basis. */
  reviewNote: narrative(10, 2000).optional(),
});
export type SetDecisionPublishableInput = z.infer<typeof setDecisionPublishableInput>;

/* ------------------------------------------------------------ public shapes */

/** A moderation case as shown in the queue. */
export const caseSummary = z.object({
  id: z.string(),
  reportId: z.string(),
  category: z.string(),
  state: caseState,
  priority: casePriority,
  grave: z.boolean(),
  assignedTo: z.string().nullable(),
  slaDueAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type CaseSummary = z.infer<typeof caseSummary>;

/** Full case view for a moderator, including internal notes. Never sent to parties. */
export const caseDetail = caseSummary.extend({
  report: z.object({
    category: z.string(),
    description: z.string(),
    incidentAt: z.iso.datetime().optional(),
    location: z.string().optional(),
    subjectLabel: z.string(),
    reporterId: z.string(),
    status: z.string(),
  }),
  evidence: z.array(
    z.object({
      id: z.string(),
      filename: z.string(),
      kind: z.string(),
      scanStatus: z.string(),
      releasable: z.boolean(),
    }),
  ),
  notes: z.array(
    z.object({
      id: z.string(),
      authorId: z.string(),
      body: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
  decision: z
    .object({
      outcome: decisionOutcome,
      rationale: z.string(),
      publishable: z.boolean(),
      issuedBy: z.string(),
      publishableSetBy: z.string().nullable(),
      appealWindowEndsAt: z.iso.datetime(),
      issuedAt: z.iso.datetime(),
    })
    .nullable(),
});
export type CaseDetail = z.infer<typeof caseDetail>;
