import { Types } from 'mongoose';
import {
  isGraveCategory,
  type AddCaseNoteInput,
  type CasePriority,
  type CaseState,
  type IssueDecisionInput,
  type ListQueueQuery,
  type ReportCategory,
  type SetDecisionPublishableInput,
} from '@safecheck/shared';
import { EVIDENCE_RELEASABLE_STATUSES } from '@safecheck/shared';
import {
  Appeal,
  Decision,
  Evidence,
  ModerationCase,
  Report,
  SubjectProfile,
  User,
  type ModerationCaseDoc,
} from '../../models/index.js';
import { badRequest, conflict, forbidden, notFound, preconditionFailed } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { recordAudit, type AuditContext } from '../../services/audit.service.js';
import { markSubjectNotified, subjectLabel } from '../../services/subject.service.js';
import { transitionReport } from '../reports/report.service.js';
import { evaluateDisclosure, BLOCK_REASON_TEXT } from '../../domain/visibility.js';
import { mailer } from '../../services/messaging.service.js';

/**
 * Moderation service.
 *
 * This module holds the two acts with the greatest consequences for a person who
 * never signed up for SafeCheck: issuing a decision about them, and clearing that
 * decision for publication. The separation between those two is the product's
 * central safety property, so it is structural here, not advisory:
 *
 *   • `issueDecision` cannot set `publishable`. There is no parameter for it.
 *   • `setDecisionPublishable` cannot change an outcome. It only flips a flag.
 *   • For grave categories, the moderator who publishes must not be the one who
 *     decided — two humans, or nothing becomes searchable.
 *
 * Even after all of that, publication is still not disclosure. The publication
 * gate (domain/visibility.ts) independently re-checks the appeal window, the
 * subject notification, and any pending appeal every time search runs.
 */

const MS_PER_DAY = 86_400_000;

/* ---------------------------------------------------------------- case load */

export async function loadCase(caseId: string): Promise<ModerationCaseDoc> {
  if (!Types.ObjectId.isValid(caseId)) throw notFound('Case not found');
  const kase = await ModerationCase.findById(caseId);
  if (!kase) throw notFound('Case not found');
  return kase;
}

/**
 * Load a case and require that the actor is the moderator working it.
 *
 * Read access is open to any moderator (they need to triage), but acts that
 * change the record — notes, decisions — belong to the assignee. An admin can
 * always act, so a case can't be held hostage by an absent moderator.
 */
async function requireAssignee(params: {
  kase: ModerationCaseDoc;
  actorId: string;
  actorRole: string;
  action: string;
}): Promise<void> {
  if (params.actorRole === 'admin') return;
  if (!params.kase.assignedTo) {
    throw preconditionFailed(`Assign this case to yourself before you ${params.action}.`);
  }
  if (params.kase.assignedTo.toString() !== params.actorId) {
    throw forbidden(`This case is assigned to another moderator.`);
  }
}

/* -------------------------------------------------------------------- queue */

/**
 * The work queue. Ordered by priority then age, so grave reports surface first
 * and nothing rots quietly at the bottom.
 *
 * Deliberately returns labels and categories only — never the narrative. A
 * moderator reads the allegation on the case page, where the access is audited,
 * not by scrolling a list.
 */
export async function listQueue(params: { query: ListQueueQuery; actorId: string }) {
  const { query } = params;
  const filter: Record<string, unknown> = {};
  if (query.state) filter.state = query.state;
  if (query.priority) filter.priority = query.priority;
  if (query.assignedToMe) filter.assignedTo = new Types.ObjectId(params.actorId);

  const cases = await ModerationCase.find(filter)
    .sort({ priority: -1, createdAt: 1 })
    .limit(query.limit);

  const reports = await Report.find({ _id: { $in: cases.map((c) => c.reportId) } })
    .select('category status')
    .lean();
  const byId = new Map(reports.map((r) => [r._id.toString(), r]));

  return cases.map((kase) => {
    const report = byId.get(kase.reportId.toString());
    return {
      id: kase._id.toString(),
      reportId: kase.reportId.toString(),
      category: report?.category ?? 'unknown',
      reportStatus: report?.status ?? 'unknown',
      state: kase.state,
      priority: kase.priority,
      grave: kase.grave,
      assignedTo: kase.assignedTo?.toString() ?? null,
      slaDueAt: kase.slaDueAt?.toISOString() ?? null,
      /** Past the SLA is a reporting signal for supervisors — never an escalation. */
      overdue: Boolean(kase.slaDueAt && kase.slaDueAt.getTime() < Date.now() && kase.state !== 'closed'),
      createdAt: kase.createdAt.toISOString(),
    };
  });
}

/* ------------------------------------------------------------------- assign */

/**
 * Report statuses that mirror a case state, so the reporter sees progress
 * without a moderator having to update two things. Case states absent from this
 * table leave the report alone.
 *
 * Shared by assignCase and setCaseState, and it has to be: assignment moves a
 * case to `assigned` without going through setCaseState, so if it skipped the
 * mirror the report would sit in `submitted` — from which the report transition
 * table permits no route to `decided`. That left every submitted report
 * impossible to decide through the API.
 */
const REPORT_STATUS_FOR_CASE_STATE: Partial<Record<CaseState, 'triage' | 'under_review'>> = {
  assigned: 'triage',
  investigating: 'under_review',
};

/**
 * Bring the report's status into line with a case state.
 *
 * Called before the case is mutated, so an illegal report transition aborts the
 * case change rather than leaving the two out of step.
 */
async function mirrorReportStatus(params: {
  kase: ModerationCaseDoc;
  to: CaseState;
  actorId: string;
  context: AuditContext;
}): Promise<void> {
  const reportStatus = REPORT_STATUS_FOR_CASE_STATE[params.to];
  if (!reportStatus) return;

  const report = await Report.findById(params.kase.reportId);
  if (!report || report.status === reportStatus) return;

  await transitionReport({
    report,
    to: reportStatus,
    actorId: params.actorId,
    context: params.context,
  });
}

export async function assignCase(params: {
  kase: ModerationCaseDoc;
  actorId: string;
  actorRole: string;
  moderatorId?: string;
  context: AuditContext;
}): Promise<ModerationCaseDoc> {
  const { kase } = params;

  if (kase.state === 'closed') {
    throw preconditionFailed('This case is closed.');
  }

  // Only an admin may assign work to someone else; a moderator self-assigns.
  const target = params.moderatorId ?? params.actorId;
  if (target !== params.actorId && params.actorRole !== 'admin') {
    throw forbidden('Only an admin can assign a case to another moderator.');
  }

  const assignee = await User.findById(target).select('role').lean();
  if (!assignee || (assignee.role !== 'moderator' && assignee.role !== 'admin')) {
    throw badRequest('That user is not a moderator.');
  }

  const opening = kase.state === 'unassigned';
  // Mirrored first: if the report cannot legally reach triage, the assignment is
  // not recorded either.
  if (opening) {
    await mirrorReportStatus({
      kase,
      to: 'assigned',
      actorId: params.actorId,
      context: params.context,
    });
  }

  kase.assignedTo = new Types.ObjectId(target);
  kase.assignedAt = new Date();
  if (opening) kase.state = 'assigned';
  await kase.save();

  await recordAudit('case.assigned', {
    context: params.context,
    targetType: 'ModerationCase',
    targetId: kase._id.toString(),
    meta: { assignedTo: target, selfAssigned: target === params.actorId },
  });

  return kase;
}

/* -------------------------------------------------------------- case state */

const CASE_STATE_TRANSITIONS: Readonly<Record<CaseState, readonly CaseState[]>> = Object.freeze({
  unassigned: ['assigned', 'closed'],
  assigned: ['investigating', 'awaiting_decision', 'closed'],
  investigating: ['awaiting_decision', 'closed'],
  awaiting_decision: ['investigating', 'closed'],
  closed: [],
});

/**
 * Move a case through the moderation workflow, mirroring the report status so
 * the reporter sees progress. The report transition is the authoritative one —
 * if it is illegal, this throws before the case is touched.
 */
export async function setCaseState(params: {
  kase: ModerationCaseDoc;
  to: CaseState;
  actorId: string;
  actorRole: string;
  context: AuditContext;
}): Promise<ModerationCaseDoc> {
  const { kase, to } = params;
  const from = kase.state as CaseState;

  if (from === to) return kase;
  if (!CASE_STATE_TRANSITIONS[from].includes(to)) {
    throw preconditionFailed(`A case that is ${from} cannot become ${to}.`);
  }
  await requireAssignee({ ...params, action: 'change its state' });

  // Keep the reporter's view in step with the moderator's, before the case moves.
  await mirrorReportStatus({ kase, to, actorId: params.actorId, context: params.context });

  kase.state = to;
  if (to === 'closed') kase.closedAt = new Date();
  await kase.save();

  await recordAudit('case.state_changed', {
    context: params.context,
    targetType: 'ModerationCase',
    targetId: kase._id.toString(),
    meta: { from, to },
  });

  return kase;
}

export async function setCasePriority(params: {
  kase: ModerationCaseDoc;
  priority: CasePriority;
  actorId: string;
  actorRole: string;
  context: AuditContext;
}): Promise<ModerationCaseDoc> {
  const { kase } = params;
  const from = kase.priority;
  kase.priority = params.priority;
  await kase.save();

  await recordAudit('case.priority_set', {
    context: params.context,
    targetType: 'ModerationCase',
    targetId: kase._id.toString(),
    meta: { from, to: params.priority },
  });
  return kase;
}

/* -------------------------------------------------------------------- notes */

export async function addCaseNote(params: {
  kase: ModerationCaseDoc;
  actorId: string;
  actorRole: string;
  input: AddCaseNoteInput;
  context: AuditContext;
}): Promise<ModerationCaseDoc> {
  const { kase } = params;
  await requireAssignee({ ...params, action: 'add notes' });

  kase.notes.push({
    authorId: new Types.ObjectId(params.actorId),
    body: params.input.body,
    visibility: params.input.visibility,
    createdAt: new Date(),
  });
  await kase.save();

  // The note body is deliberately not in the audit meta — it can quote the
  // allegation. That a note was added, by whom, is what the trail needs.
  await recordAudit('case.note_added', {
    context: params.context,
    targetType: 'ModerationCase',
    targetId: kase._id.toString(),
    meta: { noteCount: kase.notes.length },
  });

  return kase;
}

/* ----------------------------------------------------------------- decision */

/**
 * Issue a decision on a report.
 *
 * Note the absence of any publication parameter. Issuing a decision tells the
 * parties the outcome and starts the appeal clock; it discloses nothing to
 * anyone else, whatever the outcome. Making a record searchable is a separate
 * act with a separate authorisation check — see setDecisionPublishable.
 */
export async function issueDecision(params: {
  kase: ModerationCaseDoc;
  actorId: string;
  actorRole: string;
  input: IssueDecisionInput;
  context: AuditContext;
}) {
  const { kase, input } = params;
  await requireAssignee({ ...params, action: 'issue a decision' });

  // At most one *live* decision per report. A vacated one stays on record — the
  // appeal trail depends on it — so this check must exclude vacated decisions or
  // a report could never be re-decided after a successful appeal.
  const live = await Decision.findOne({ reportId: kase.reportId, vacatedAt: null });
  if (live) {
    throw conflict('This report has already been decided. Amend it through the appeal process.');
  }

  const report = await Report.findById(kase.reportId);
  if (!report) throw notFound('Report not found');
  if (report.status === 'withdrawn') {
    throw preconditionFailed('This report was withdrawn and cannot be decided.');
  }

  // Terminal state for the report; the transition table rejects an illegal edge.
  await transitionReport({
    report,
    to: 'decided',
    actorId: params.actorId,
    context: params.context,
  });

  const appealWindowEndsAt = new Date(Date.now() + env.APPEAL_WINDOW_DAYS * MS_PER_DAY);

  const decision = await Decision.create({
    reportId: report._id,
    caseId: kase._id,
    subjectId: report.subjectId,
    outcome: input.outcome,
    rationale: input.rationale,
    issuedBy: new Types.ObjectId(params.actorId),
    issuedAt: new Date(),
    // Explicitly false. Publication is never a side effect of deciding.
    publishable: false,
    appealWindowEndsAt,
  });

  report.decisionId = decision._id;
  await report.save();

  kase.state = 'closed';
  kase.closedAt = new Date();
  await kase.save();

  // The subject is told a decision concerns them, and the timestamp is recorded.
  // The publication gate refuses to disclose anything about a subject who was
  // never notified, so this is a precondition for publication, not a courtesy.
  await notifySubjectOfDecision({ subjectId: report.subjectId, context: params.context });

  await recordAudit('decision.issued', {
    context: params.context,
    targetType: 'Decision',
    targetId: decision._id.toString(),
    meta: {
      reportId: report._id.toString(),
      outcome: input.outcome,
      grave: kase.grave,
      appealWindowEndsAt: appealWindowEndsAt.toISOString(),
    },
  });

  return decision;
}

/**
 * Tell the subject that a decision concerns them, and record when.
 *
 * A subject with no platform account can only be reached if they have an
 * identifier we can send to — and we hold only hashes, so we cannot. That case
 * is recorded honestly as an unnotified subject, which the publication gate then
 * treats as a permanent block on disclosure. Failing closed is the right
 * outcome: we do not publish about people we could not tell.
 */
async function notifySubjectOfDecision(params: {
  subjectId: Types.ObjectId;
  context: AuditContext;
}): Promise<void> {
  const subject = await SubjectProfile.findById(params.subjectId);
  if (!subject) return;

  if (!subject.linkedUserId) {
    // No account, no reachable address (identifiers are hashes). Leave
    // notifiedAt null; the gate will block publication until a moderator
    // records an out-of-band notification.
    return;
  }

  const account = await User.findById(subject.linkedUserId).select('email').lean();
  if (!account) return;

  await mailer.send({
    to: account.email,
    subject: 'A decision has been made on a report that concerns you',
    body:
      'A report naming you has been reviewed and decided by a SafeCheck moderator.\n\n' +
      'Sign in to read the decision and the reasons for it. If you disagree, you can ' +
      `appeal within ${env.APPEAL_WINDOW_DAYS} days.\n\n` +
      'Nothing about this report is visible to anyone else while your appeal window is open.',
  });

  await markSubjectNotified(subject._id.toString(), 'email');
  await recordAudit('subject.notified', {
    context: params.context,
    targetType: 'SubjectProfile',
    targetId: subject._id.toString(),
    meta: { channel: 'email', reason: 'decision.issued' },
  });
}

/* -------------------------------------------------------------- publication */

/**
 * Mark a decision publishable — or withdraw that mark.
 *
 * The checks here are the last human gate before a record can ever reach a
 * stranger. Ordering matters: every refusal below must happen before the flag is
 * written, because a moment of publishable=true on a vacated or appealed
 * decision is a moment in which search could disclose it.
 */
export async function setDecisionPublishable(params: {
  decisionId: string;
  actorId: string;
  actorRole: string;
  input: SetDecisionPublishableInput;
  context: AuditContext;
}) {
  if (!Types.ObjectId.isValid(params.decisionId)) throw notFound('Decision not found');
  const decision = await Decision.findById(params.decisionId);
  if (!decision) throw notFound('Decision not found');

  if (!params.input.publishable) {
    // Un-publishing is always allowed and always safe — no second moderator
    // required to make something less visible.
    decision.publishable = false;
    decision.publishableSetBy = new Types.ObjectId(params.actorId);
    decision.publishableSetAt = new Date();
    await decision.save();

    await recordAudit('decision.unpublished', {
      context: params.context,
      targetType: 'Decision',
      targetId: decision._id.toString(),
    });
    return decision;
  }

  if (!params.input.reviewNote) {
    throw badRequest('Explain the basis for publishing this record.');
  }

  // Only an upheld allegation can ever be published. Anything else says the
  // platform did not find the report substantiated, and publishing that would be
  // exactly the labelling this product refuses to do.
  if (decision.outcome !== 'upheld') {
    throw preconditionFailed(
      'Only an upheld decision can be published. This decision did not uphold the report.',
    );
  }
  if (decision.vacatedAt) {
    throw preconditionFailed('This decision was vacated on appeal and can never be published.');
  }

  const report = await Report.findById(decision.reportId);
  if (!report) throw notFound('Report not found');
  if (report.withdrawnAt) {
    throw preconditionFailed('The reporter withdrew this report, so it cannot be published.');
  }

  const appeals = await Appeal.find({ decisionId: decision._id }).select('state').lean();
  if (appeals.some((a) => a.state === 'filed' || a.state === 'under_review')) {
    throw preconditionFailed('An appeal is pending. Resolve it before considering publication.');
  }

  // ── The two-moderator rule ─────────────────────────────────────────────────
  // For grave categories the consequences of a wrong publication are severe and
  // effectively irreversible for the person named. One moderator decides; a
  // different one must agree to publish.
  const kase = await ModerationCase.findById(decision.caseId);
  const grave = kase?.grave ?? isGraveCategory(report.category as ReportCategory);
  if (grave && decision.issuedBy.toString() === params.actorId) {
    throw forbidden(
      'This is a grave-category report. A moderator other than the one who decided it must approve publication.',
    );
  }

  decision.publishable = true;
  decision.publishableSetBy = new Types.ObjectId(params.actorId);
  decision.publishableSetAt = new Date();
  decision.publicationReviewNote = params.input.reviewNote;
  await decision.save();

  await recordAudit('decision.publishable_set', {
    context: params.context,
    targetType: 'Decision',
    targetId: decision._id.toString(),
    meta: {
      reportId: report._id.toString(),
      grave,
      issuedBy: decision.issuedBy.toString(),
      // Recording both parties is what makes the two-moderator rule auditable
      // after the fact, not just enforced in the moment.
      approvedBy: params.actorId,
    },
  });

  return decision;
}

/**
 * Explain, for the moderator UI, exactly why a decision is or isn't disclosable.
 *
 * This asks the publication gate rather than re-deriving the conditions, so the
 * explanation shown to a moderator can never drift from the rule actually
 * applied by search.
 */
export async function explainDisclosure(decisionId: string) {
  const decision = await Decision.findById(decisionId);
  if (!decision) throw notFound('Decision not found');

  const [report, subject, appeals] = await Promise.all([
    Report.findById(decision.reportId).select('withdrawnAt').lean(),
    SubjectProfile.findById(decision.subjectId).select('notifiedAt').lean(),
    Appeal.find({ decisionId: decision._id }).select('state').lean(),
  ]);

  const verdict = evaluateDisclosure({
    outcome: decision.outcome,
    publishable: decision.publishable,
    vacatedAt: decision.vacatedAt ?? null,
    reportWithdrawnAt: report?.withdrawnAt ?? null,
    subjectNotifiedAt: subject?.notifiedAt ?? null,
    appealWindowEndsAt: decision.appealWindowEndsAt,
    appealStates: appeals.map((a) => a.state),
    appealWindowDays: env.APPEAL_WINDOW_DAYS,
    now: new Date(),
  });

  return {
    disclosable: verdict.disclosable,
    reasons: verdict.disclosable ? [] : verdict.reasons.map((r) => BLOCK_REASON_TEXT[r]),
    effectiveAppealDeadline: verdict.effectiveAppealDeadline?.toISOString() ?? null,
  };
}

/* ------------------------------------------------------------ serialisation */

/** The full moderator view of a case, including internal notes. Never sent to a party. */
export async function toCaseDetail(kase: ModerationCaseDoc) {
  const report = await Report.findById(kase.reportId);
  if (!report) throw notFound('Report not found');

  const [subject, evidenceItems, decision] = await Promise.all([
    SubjectProfile.findById(report.subjectId),
    Evidence.find({ reportId: report._id }).sort({ createdAt: 1 }),
    Report.findById(report._id).then((r) => (r?.decisionId ? Decision.findById(r.decisionId) : null)),
  ]);

  return {
    id: kase._id.toString(),
    reportId: report._id.toString(),
    category: report.category,
    state: kase.state,
    priority: kase.priority,
    grave: kase.grave,
    assignedTo: kase.assignedTo?.toString() ?? null,
    slaDueAt: kase.slaDueAt?.toISOString() ?? null,
    createdAt: kase.createdAt.toISOString(),
    report: {
      category: report.category,
      description: report.description,
      incidentAt: report.incidentAt?.toISOString(),
      location: report.location,
      // A label, never an identifier or its hash — a moderator has no need for
      // the subject's email to adjudicate, and holding it on screen is a risk.
      subjectLabel: subject ? subjectLabel(subject) : 'Unknown subject',
      subjectNotifiedAt: subject?.notifiedAt?.toISOString() ?? null,
      reporterId: report.reporterId.toString(),
      status: report.status,
    },
    evidence: evidenceItems.map((item) => ({
      id: item._id.toString(),
      filename: item.filename,
      kind: item.kind,
      scanStatus: item.scanStatus,
      releasable:
        item.purgedAt === null &&
        (EVIDENCE_RELEASABLE_STATUSES as readonly string[]).includes(item.scanStatus),
    })),
    notes: kase.notes.map((note) => ({
      id: note._id.toString(),
      authorId: note.authorId.toString(),
      body: note.body,
      createdAt: note.createdAt.toISOString(),
    })),
    decision: decision
      ? {
          id: decision._id.toString(),
          outcome: decision.outcome,
          rationale: decision.rationale,
          publishable: decision.publishable,
          issuedBy: decision.issuedBy.toString(),
          publishableSetBy: decision.publishableSetBy?.toString() ?? null,
          appealWindowEndsAt: decision.appealWindowEndsAt.toISOString(),
          issuedAt: decision.issuedAt.toISOString(),
          vacatedAt: decision.vacatedAt?.toISOString() ?? null,
        }
      : null,
  };
}
