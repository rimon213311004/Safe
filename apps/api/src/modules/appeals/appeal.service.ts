import { Types } from 'mongoose';
import {
  isAppealPending,
  type AppealParty,
  type FileAppealInput,
  type ResolveAppealInput,
} from '@safecheck/shared';
import {
  Appeal,
  Decision,
  ModerationCase,
  Report,
  SubjectProfile,
  type AppealDoc,
} from '../../models/index.js';
import { badRequest, conflict, forbidden, notFound, preconditionFailed } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { recordAudit, type AuditContext } from '../../services/audit.service.js';
import { transitionReport } from '../reports/report.service.js';
import { effectiveAppealDeadline } from '../../domain/visibility.js';

/**
 * Appeal service.
 *
 * An appeal is the mechanism that makes the rest of the pipeline legitimate. Two
 * rules are load-bearing:
 *
 *   1. INDEPENDENT REVIEW. The moderator who issued a decision may not review the
 *      appeal against it, and neither may the moderator who approved it for
 *      publication. Without this, "appeal" means asking someone to overturn
 *      themselves, which is not a remedy.
 *
 *   2. NO GAP BETWEEN THE APPEAL WINDOW AND THE PUBLICATION GATE. Filing is
 *      permitted right up to the same `effectiveAppealDeadline` the gate waits
 *      for — computed by the same function, deliberately. If the filing deadline
 *      were even a moment earlier, there would be an interval in which a person
 *      could be published about but could no longer appeal.
 */

/* ------------------------------------------------------------------- lookups */

async function loadLiveDecisionForReport(reportId: Types.ObjectId) {
  const decision = await Decision.findOne({ reportId, vacatedAt: null });
  if (!decision) throw notFound('There is no decision on this report to appeal.');
  return decision;
}

export async function loadAppealForActor(params: {
  appealId: string;
  actorId: string;
  actorRole: string;
}): Promise<AppealDoc> {
  if (!Types.ObjectId.isValid(params.appealId)) throw notFound('Appeal not found');
  const appeal = await Appeal.findById(params.appealId);
  if (!appeal) throw notFound('Appeal not found');

  const isModerator = params.actorRole === 'moderator' || params.actorRole === 'admin';
  if (isModerator) return appeal;

  // A party may read their own appeal. Anyone else gets 404 rather than 403 —
  // confirming an appeal exists would confirm a report exists.
  if (appeal.filedByUserId?.toString() === params.actorId) return appeal;
  throw notFound('Appeal not found');
}

/* --------------------------------------------------------------- entitlement */

/**
 * Confirm the caller is actually the party they claim to be.
 *
 * The `party` field is client-supplied, so it is a claim, not a fact. A reporter
 * must not be able to file "as the subject" — the two have opposed interests and
 * separate rights.
 */
async function assertEntitledToAppeal(params: {
  party: AppealParty;
  actorId: string;
  reporterId: Types.ObjectId;
  subjectId: Types.ObjectId;
}): Promise<void> {
  if (params.party === 'reporter') {
    if (params.reporterId.toString() !== params.actorId) {
      throw forbidden('Only the reporter can appeal as the reporter.');
    }
    return;
  }

  const subject = await SubjectProfile.findById(params.subjectId).select('linkedUserId').lean();
  if (!subject?.linkedUserId || subject.linkedUserId.toString() !== params.actorId) {
    // A subject with no linked account cannot appeal through the API in Pass 1.
    // They also cannot be published about — the gate blocks on `subject_not_notified`
    // — so the asymmetry is safe, but an out-of-band appeal route is needed before
    // any deployment that notifies subjects off-platform.
    throw forbidden('Only the person this report concerns can appeal as the subject.');
  }
}

/* -------------------------------------------------------------------- filing */

export async function fileAppeal(params: {
  reportId: string;
  actorId: string;
  input: FileAppealInput;
  context: AuditContext;
}): Promise<AppealDoc> {
  if (!Types.ObjectId.isValid(params.reportId)) throw notFound('Report not found');
  const report = await Report.findById(params.reportId);
  if (!report) throw notFound('Report not found');

  const decision = await loadLiveDecisionForReport(report._id);

  await assertEntitledToAppeal({
    party: params.input.party,
    actorId: params.actorId,
    reporterId: report.reporterId,
    subjectId: report.subjectId,
  });

  // Same deadline the publication gate waits for — see the module comment. A
  // subject notified late gets a full window from their notification, and the
  // gate independently refuses to publish before that same instant.
  const subject = await SubjectProfile.findById(report.subjectId).select('notifiedAt').lean();
  const deadline = subject?.notifiedAt
    ? effectiveAppealDeadline(
        decision.appealWindowEndsAt,
        subject.notifiedAt,
        env.APPEAL_WINDOW_DAYS,
      )
    : decision.appealWindowEndsAt;

  if (Date.now() > deadline.getTime()) {
    throw preconditionFailed('The appeal window for this decision has closed.');
  }

  // One appeal per party per decision. The reporter and the subject each get
  // their own, because they are appealing different things.
  const existing = await Appeal.findOne({
    decisionId: decision._id,
    party: params.input.party,
    state: { $ne: 'withdrawn' },
  });
  if (existing) {
    throw conflict('You have already appealed this decision.');
  }

  const appeal = await Appeal.create({
    decisionId: decision._id,
    reportId: report._id,
    party: params.input.party,
    filedByUserId: new Types.ObjectId(params.actorId),
    grounds: params.input.grounds,
    state: 'filed',
  });

  // Note what is NOT done here: `decision.publishable` is left untouched. The
  // publication gate vetoes on a pending appeal independently, so publication is
  // already blocked. Mutating the flag would mean an appeal that is later
  // withdrawn had silently revoked a moderator's decision.
  await recordAudit('appeal.filed', {
    context: params.context,
    targetType: 'Appeal',
    targetId: appeal._id.toString(),
    meta: {
      reportId: report._id.toString(),
      decisionId: decision._id.toString(),
      party: params.input.party,
    },
  });

  return appeal;
}

/* ------------------------------------------------------------------ withdraw */

export async function withdrawAppeal(params: {
  appeal: AppealDoc;
  actorId: string;
  context: AuditContext;
}): Promise<AppealDoc> {
  const { appeal } = params;

  if (appeal.filedByUserId?.toString() !== params.actorId) {
    throw forbidden('Only the person who filed this appeal can withdraw it.');
  }
  if (!isAppealPending(appeal.state)) {
    throw preconditionFailed('This appeal has already been resolved.');
  }

  appeal.state = 'withdrawn';
  appeal.resolvedAt = new Date();
  await appeal.save();

  await recordAudit('appeal.resolved', {
    context: params.context,
    targetType: 'Appeal',
    targetId: appeal._id.toString(),
    meta: { outcome: 'withdrawn', byAppellant: true },
  });

  return appeal;
}

/* ----------------------------------------------------- independent reviewer */

/**
 * The independence check. Kept as its own function so both claiming and resolving
 * an appeal apply exactly the same rule — a reviewer who could not resolve an
 * appeal must not be able to claim it either, or they can park it indefinitely.
 */
async function assertIndependentReviewer(params: {
  decisionId: Types.ObjectId;
  actorId: string;
}): Promise<void> {
  const decision = await Decision.findById(params.decisionId)
    .select('issuedBy publishableSetBy')
    .lean();
  if (!decision) throw notFound('Decision not found');

  if (decision.issuedBy.toString() === params.actorId) {
    throw forbidden(
      'You issued this decision, so you cannot review the appeal against it. Another moderator must.',
    );
  }
  // Someone who already signed off on publishing this record has taken a public
  // position on it and is not an independent reviewer either.
  if (decision.publishableSetBy?.toString() === params.actorId) {
    throw forbidden(
      'You approved this record for publication, so you cannot review the appeal against it.',
    );
  }
}

export async function claimAppeal(params: {
  appeal: AppealDoc;
  actorId: string;
  context: AuditContext;
}): Promise<AppealDoc> {
  const { appeal } = params;

  if (appeal.state !== 'filed') {
    throw preconditionFailed('This appeal is no longer awaiting a reviewer.');
  }
  await assertIndependentReviewer({ decisionId: appeal.decisionId, actorId: params.actorId });

  appeal.reviewerId = new Types.ObjectId(params.actorId);
  appeal.state = 'under_review';
  await appeal.save();

  return appeal;
}

/* ------------------------------------------------------------------- resolve */

/**
 * Resolve an appeal.
 *
 * Granting with `vacate` (or `amend`, see below) takes the decision out of
 * effect: it is marked vacated, publishability is revoked, and the report returns
 * to review for a fresh decision. The vacated decision is never deleted — the
 * record of what was decided and then overturned is exactly what an appeal
 * process needs to leave behind.
 *
 * `amend` currently behaves as vacate-and-re-decide, because the resolve schema
 * carries no replacement outcome. A first-class amendment would need one; until
 * then the corrected outcome is issued as a new decision by a moderator, which
 * keeps both records intact.
 */
export async function resolveAppeal(params: {
  appeal: AppealDoc;
  actorId: string;
  input: ResolveAppealInput;
  context: AuditContext;
}): Promise<AppealDoc> {
  const { appeal, input } = params;

  if (!isAppealPending(appeal.state)) {
    throw preconditionFailed('This appeal has already been resolved.');
  }
  await assertIndependentReviewer({ decisionId: appeal.decisionId, actorId: params.actorId });

  const decision = await Decision.findById(appeal.decisionId);
  if (!decision) throw notFound('Decision not found');

  appeal.reviewerId = new Types.ObjectId(params.actorId);
  appeal.state = input.decision === 'granted' ? 'granted' : 'denied';
  appeal.resolution = {
    decision: input.decision,
    rationale: input.rationale,
    effect: input.effect ?? null,
  };
  appeal.resolvedAt = new Date();
  await appeal.save();

  const vacates = input.decision === 'granted' && (input.effect === 'vacate' || input.effect === 'amend');

  if (vacates) {
    decision.vacatedAt = new Date();
    decision.vacatedReason = input.rationale;
    // Revoked explicitly as well as being vetoed by the gate. Two independent
    // mechanisms, because a vacated decision becoming searchable is the worst
    // failure this system could have.
    decision.publishable = false;
    await decision.save();

    const report = await Report.findById(appeal.reportId);
    if (report && report.status === 'decided') {
      await transitionReport({
        report,
        to: 'under_review',
        actorId: params.actorId,
        context: params.context,
        reason: 'Decision vacated on appeal',
      });
    }

    // Reopen the case so a moderator can re-decide. Without this the report sits
    // in under_review with a closed case and nobody owning it.
    await ModerationCase.updateOne(
      { _id: decision.caseId },
      { $set: { state: 'investigating', closedAt: null } },
    );
  }

  await recordAudit('appeal.resolved', {
    context: params.context,
    targetType: 'Appeal',
    targetId: appeal._id.toString(),
    meta: {
      reportId: appeal.reportId.toString(),
      decisionId: decision._id.toString(),
      outcome: input.decision,
      effect: input.effect ?? null,
      vacated: vacates,
      reviewedBy: params.actorId,
      issuedBy: decision.issuedBy.toString(),
    },
  });

  return appeal;
}

/* ------------------------------------------------------------ serialisation */

export function toAppealSummary(appeal: AppealDoc) {
  return {
    id: appeal._id.toString(),
    reportId: appeal.reportId.toString(),
    party: appeal.party,
    state: appeal.state,
    filedAt: appeal.createdAt.toISOString(),
    resolvedAt: appeal.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * Party-facing appeal detail. The reviewer's identity is deliberately omitted —
 * a party is entitled to the reasoning, not to the name of the moderator who
 * ruled against them.
 */
export function toAppealDetail(appeal: AppealDoc) {
  return {
    ...toAppealSummary(appeal),
    grounds: appeal.grounds,
    resolution:
      appeal.resolution?.decision && appeal.resolution.rationale
        ? {
            decision: appeal.resolution.decision,
            rationale: appeal.resolution.rationale,
            effect: appeal.resolution.effect ?? null,
          }
        : null,
  };
}

export async function listAppealsForReport(reportId: Types.ObjectId) {
  const appeals = await Appeal.find({ reportId }).sort({ createdAt: 1 });
  return appeals.map(toAppealSummary);
}

/** The moderator queue of appeals awaiting independent review. */
export async function listPendingAppeals(limit: number) {
  const appeals = await Appeal.find({ state: { $in: ['filed', 'under_review'] } })
    .sort({ createdAt: 1 })
    .limit(limit);

  const decisions = await Decision.find({ _id: { $in: appeals.map((a) => a.decisionId) } })
    .select('issuedBy outcome')
    .lean();
  const byId = new Map(decisions.map((d) => [d._id.toString(), d]));

  return appeals.map((appeal) => {
    const decision = byId.get(appeal.decisionId.toString());
    return {
      ...toAppealSummary(appeal),
      grounds: appeal.grounds,
      /** Surfaced so the UI can hide cases this moderator must not review. */
      decisionIssuedBy: decision?.issuedBy.toString() ?? null,
      decisionOutcome: decision?.outcome ?? null,
      reviewerId: appeal.reviewerId?.toString() ?? null,
    };
  });
}

/** Guard used by the routes to reject a malformed party value early. */
export function assertKnownParty(party: string): AppealParty {
  if (party !== 'reporter' && party !== 'subject') {
    throw badRequest('Unknown appeal party.');
  }
  return party;
}
