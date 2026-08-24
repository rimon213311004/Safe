import { Types } from 'mongoose';
import {
  canTransitionReport,
  isGraveCategory,
  type ReportCategory,
  type ReportStatus,
  type CreateReportInput,
  type UpdateReportDraftInput,
} from '@safecheck/shared';
import { EVIDENCE_RELEASABLE_STATUSES } from '@safecheck/shared';
import {
  Appeal,
  Decision,
  Evidence,
  ModerationCase,
  Report,
  SubjectProfile,
  type ReportDoc,
} from '../../models/index.js';
import { badRequest, forbidden, notFound, preconditionFailed } from '../../lib/errors.js';
import { recordAudit, type AuditContext } from '../../services/audit.service.js';
import { resolveSubject, subjectLabel } from '../../services/subject.service.js';

/**
 * Report service.
 *
 * Two invariants are enforced here and nowhere else:
 *
 *   1. Status only ever moves along a legal edge (see REPORT_STATUS_TRANSITIONS).
 *      No caller writes `status` directly — everything goes through
 *      `transitionReport`, so "decided" can never be set by, say, a draft update.
 *
 *   2. Submitting a report opens a ModerationCase. A submitted allegation always
 *      has a human owner; nothing is auto-adjudicated, and nothing about it is
 *      disclosed as a consequence of being filed.
 */

/* --------------------------------------------------------------------- read */

/** Load a report the actor is entitled to see, or fail indistinguishably. */
export async function loadReportForActor(params: {
  reportId: string;
  actorId: string;
  actorRole: string;
}): Promise<ReportDoc> {
  if (!Types.ObjectId.isValid(params.reportId)) throw notFound('Report not found');

  const report = await Report.findById(params.reportId);
  if (!report) throw notFound('Report not found');

  const isReporter = report.reporterId.toString() === params.actorId;
  const isModerator = params.actorRole === 'moderator' || params.actorRole === 'admin';

  // A non-party gets 404 rather than 403: confirming a report exists about a
  // given person is itself a disclosure.
  if (!isReporter && !isModerator) throw notFound('Report not found');

  return report;
}

/* ------------------------------------------------------------------- create */

export async function createReport(params: {
  reporterId: string;
  input: CreateReportInput;
  context: AuditContext;
}): Promise<ReportDoc> {
  const { input } = params;

  // Hashing happens inside resolveSubject; the plaintext identifiers in
  // `input.subject` are not persisted and must not be logged.
  const subject = await resolveSubject(input.subject);

  // A reporter cannot file against their own identifiers — that is either a
  // mistake or an attempt to manufacture a clean record for themselves.
  if (subject.linkedUserId && subject.linkedUserId.toString() === params.reporterId) {
    throw badRequest('You cannot file a report about yourself.');
  }

  const report = await Report.create({
    reporterId: new Types.ObjectId(params.reporterId),
    subjectId: subject._id,
    category: input.category,
    description: input.description,
    incidentAt: input.incidentAt ? new Date(input.incidentAt) : null,
    location: input.location ?? '',
    // The attestation is a legal artefact: record when it was made, not just that
    // it was. Zod has already required it to be literally `true`.
    attestedAt: new Date(),
    status: 'draft',
  });

  await recordAudit('report.created', {
    context: params.context,
    targetType: 'Report',
    targetId: report._id.toString(),
    // Category is recorded; the narrative and identifiers deliberately are not.
    meta: { category: input.category },
  });

  if (input.submitNow) {
    await submitReport({ report, actorId: params.reporterId, context: params.context });
  }

  return report;
}

/* ------------------------------------------------------------------- submit */

/**
 * Move a draft into the moderation pipeline and open its case.
 *
 * Priority is seeded from gravity so that violence and sexual-harassment reports
 * surface first in the queue. This affects ordering only — never the outcome.
 */
export async function submitReport(params: {
  report: ReportDoc;
  actorId: string;
  context: AuditContext;
}): Promise<ReportDoc> {
  const { report } = params;

  if (report.reporterId.toString() !== params.actorId) {
    throw forbidden('Only the reporter can submit this report.');
  }

  // Submission is legal only out of `draft`. This has to be checked here rather
  // than left to transitionReport, which treats a same-status move as a no-op —
  // without this guard, re-submitting an already-submitted report would skip the
  // transition, overwrite `submittedAt` with a later timestamp, and only fail on
  // the unique index when the second ModerationCase was written. The filing time
  // of an allegation is not something a retry may quietly rewrite.
  if (report.status !== 'draft') {
    throw preconditionFailed(`A report that is ${report.status} cannot be submitted again.`);
  }

  await transitionReport({
    report,
    to: 'submitted',
    actorId: params.actorId,
    context: params.context,
  });

  report.submittedAt = new Date();
  await report.save();

  const grave = isGraveCategory(report.category as ReportCategory);
  await ModerationCase.create({
    reportId: report._id,
    state: 'unassigned',
    priority: grave ? 'high' : 'normal',
    grave,
    // Gives the queue an ordering signal; SLA breach is a reporting concern, not
    // an automatic escalation.
    slaDueAt: new Date(Date.now() + (grave ? 2 : 7) * 24 * 60 * 60 * 1000),
  });

  await recordAudit('report.submitted', {
    context: params.context,
    targetType: 'Report',
    targetId: report._id.toString(),
    meta: { category: report.category, grave },
  });

  return report;
}

/* --------------------------------------------------------------- transition */

/**
 * The single gate for status changes. Rejects any edge not declared legal in the
 * shared transition table, so an illegal jump is a 412 rather than silent
 * corruption of the pipeline.
 */
export async function transitionReport(params: {
  report: ReportDoc;
  to: ReportStatus;
  actorId: string;
  context: AuditContext;
  reason?: string;
}): Promise<ReportDoc> {
  const { report, to } = params;
  const from = report.status as ReportStatus;

  if (from === to) return report;

  if (!canTransitionReport(from, to)) {
    throw preconditionFailed(`A report that is ${from} cannot become ${to}.`);
  }

  report.status = to;
  await report.save();

  await recordAudit('report.status_changed', {
    context: params.context,
    targetType: 'Report',
    targetId: report._id.toString(),
    meta: { from, to, reason: params.reason ?? null },
  });

  return report;
}

/* -------------------------------------------------------------- draft edits */

export async function updateDraft(params: {
  report: ReportDoc;
  actorId: string;
  input: UpdateReportDraftInput;
}): Promise<ReportDoc> {
  const { report, input } = params;

  if (report.reporterId.toString() !== params.actorId) {
    throw forbidden('Only the reporter can edit this report.');
  }
  // Once a moderator can see it, the narrative is evidence. Editing it would
  // undermine the record, so amendments after submission are a separate act.
  if (report.status !== 'draft') {
    throw preconditionFailed('This report has been submitted and can no longer be edited.');
  }

  if (input.description !== undefined) report.description = input.description;
  if (input.incidentAt !== undefined) report.incidentAt = new Date(input.incidentAt);
  if (input.location !== undefined) report.location = input.location;

  await report.save();
  return report;
}

/* ----------------------------------------------------------------- withdraw */

/**
 * Withdrawal is always available to the reporter and is honoured immediately:
 * a withdrawn report can never be published, whatever its decision said.
 * See domain/visibility.ts, which vetoes on `report_withdrawn`.
 */
export async function withdrawReport(params: {
  report: ReportDoc;
  actorId: string;
  reason: string;
  context: AuditContext;
}): Promise<ReportDoc> {
  const { report } = params;

  if (report.reporterId.toString() !== params.actorId) {
    throw forbidden('Only the reporter can withdraw this report.');
  }
  if (report.status === 'withdrawn') return report;
  if (report.status === 'decided') {
    throw preconditionFailed(
      'This report has been decided. You can appeal the decision instead of withdrawing.',
    );
  }

  await transitionReport({
    report,
    to: 'withdrawn',
    actorId: params.actorId,
    context: params.context,
    reason: params.reason,
  });

  report.withdrawnAt = new Date();
  report.withdrawnReason = params.reason;
  await report.save();

  await ModerationCase.updateOne(
    { reportId: report._id },
    { $set: { state: 'closed', closedAt: new Date() } },
  );

  await recordAudit('report.withdrawn', {
    context: params.context,
    targetType: 'Report',
    targetId: report._id.toString(),
  });

  return report;
}

/* --------------------------------------------------------- serialisation */

/**
 * Serialise for the reporter. Note what never appears: the subject's
 * identifiers or their hashes, and any moderator-internal field.
 */
export async function toReportSummary(report: ReportDoc): Promise<{
  id: string;
  category: string;
  status: string;
  subjectLabel: string;
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
}> {
  const subject = await SubjectProfile.findById(report.subjectId);
  return {
    id: report._id.toString(),
    category: report.category,
    status: report.status,
    subjectLabel: subject ? subjectLabel(subject) : 'Unknown subject',
    evidenceCount: report.evidenceIds.length,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
  };
}

export async function listReportsForReporter(params: {
  reporterId: string;
  status?: string;
  limit: number;
}) {
  const filter: Record<string, unknown> = {
    reporterId: new Types.ObjectId(params.reporterId),
  };
  if (params.status) filter.status = params.status;

  const reports = await Report.find(filter).sort({ createdAt: -1 }).limit(params.limit);
  return Promise.all(reports.map(toReportSummary));
}

/**
 * The decision as the *parties* may see it.
 *
 * This is distinct from what search may disclose. A party is always entitled to
 * know the outcome of their own case and why — that is the right of reply the
 * whole appeal process depends on. The publication gate governs disclosure to
 * third parties, and is not consulted here.
 *
 * `internalNotes` and the `publishable` flag never appear: whether a decision has
 * been cleared for publication is a moderation matter, and revealing it would
 * invite pressure on the moderator.
 */
export async function partyVisibleDecision(report: ReportDoc): Promise<{
  outcome: string;
  rationale: string;
  issuedAt: string;
  appealWindowEndsAt: string;
  canAppeal: boolean;
} | null> {
  if (!report.decisionId) return null;

  const decision = await Decision.findById(report.decisionId);
  if (!decision || decision.vacatedAt) return null;

  const existingAppeal = await Appeal.findOne({ decisionId: decision._id });
  const windowOpen = decision.appealWindowEndsAt.getTime() > Date.now();

  return {
    outcome: decision.outcome,
    rationale: decision.rationale,
    issuedAt: decision.issuedAt.toISOString(),
    appealWindowEndsAt: decision.appealWindowEndsAt.toISOString(),
    // One appeal per decision, and only while the window is open.
    canAppeal: windowOpen && !existingAppeal,
  };
}

/** Evidence descriptors for a report, without storage keys or raw bytes. */
export async function listEvidenceForReport(reportId: Types.ObjectId) {
  const items = await Evidence.find({ reportId }).sort({ createdAt: 1 });
  return items.map((item) => ({
    id: item._id.toString(),
    reportId: item.reportId.toString(),
    filename: item.filename,
    mime: item.mime,
    kind: item.kind,
    sizeBytes: item.sizeBytes,
    caption: item.caption,
    scanStatus: item.scanStatus,
    releasable:
      item.purgedAt === null &&
      (EVIDENCE_RELEASABLE_STATUSES as readonly string[]).includes(item.scanStatus),
    createdAt: item.createdAt.toISOString(),
  }));
}
