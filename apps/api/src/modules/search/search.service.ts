import type { IdentifierType, SearchInput, SearchResult } from '@safecheck/shared';
import { SEARCH_DISCLAIMER } from '@safecheck/shared';
import type { Types } from 'mongoose';
import { hashIdentifier } from '../../lib/crypto.js';
import { Appeal, Decision, Report, SubjectProfile, User } from '../../models/index.js';
import { env } from '../../config/env.js';
import { recordAudit, type AuditContext } from '../../services/audit.service.js';
import { evaluateDisclosure, publishableCandidateFilter } from '../../domain/visibility.js';

/**
 * Search service — the only path by which anything about a person reaches a
 * stranger.
 *
 * Three rules govern this file, and all three are about what it must NOT do:
 *
 *  1. IT NEVER DISCLOSES STRAIGHT FROM A QUERY. `publishableCandidateFilter` is a
 *     performance pre-filter that cannot express the appeal join or the
 *     notification-relative deadline. Every candidate is re-checked by
 *     `evaluateDisclosure` before it is disclosed. If the two ever disagree the
 *     gate wins — see domain/visibility.ts.
 *
 *  2. `matched` NEVER REFLECTS THE EXISTENCE OF A SUBJECT PROFILE. A profile
 *     exists as soon as somebody files a report, so keying `matched` off it would
 *     turn this endpoint into an oracle for "has anyone ever accused this
 *     person" — the single worst thing this product could leak. See
 *     `resolveAccount` below.
 *
 *  3. IT NEVER RETURNS OR LOGS A PLAINTEXT IDENTIFIER. The query value is hashed
 *     on arrival and only the hash travels further, including into the audit row.
 */

/** Narrow the validated input to the one identifier it carries. */
function soleIdentifier(input: SearchInput): { type: IdentifierType; value: string } {
  if (input.email) return { type: 'email', value: input.email };
  if (input.phone) return { type: 'phone', value: input.phone };
  // The schema's refine() guarantees exactly one, so this is unreachable.
  throw new Error('searchInput passed validation with no identifier');
}

/**
 * An empty result. Returned verbatim for an unknown identifier AND for a known
 * subject with nothing disclosable, so the two are indistinguishable on the wire.
 * Any future field added to SearchResult must be safe to include here.
 */
function emptyResult(): SearchResult {
  return { matched: false, account: null, records: [], disclaimer: SEARCH_DISCLAIMER };
}

/**
 * Resolve the *account* behind an identifier, deliberately without consulting the
 * subject profile.
 *
 * It would be convenient to read `subject.linkedUserId` here — but a subject
 * profile only exists because someone filed a report, so an `account` derived
 * from it would be present exactly when an allegation exists. A searcher could
 * then infer a private report from a non-null `account`. Looking the account up
 * independently costs one indexed query and closes that inference.
 *
 * Phone numbers yield no account because an account's identity is its email; we
 * hold no phone number on User to match against. Returning null is honest rather
 * than a gap.
 */
async function resolveAccount(identifier: {
  type: IdentifierType;
  value: string;
}): Promise<SearchResult['account']> {
  if (identifier.type !== 'email') return null;

  const user = await User.findOne({ email: identifier.value })
    .select('emailVerified identityStatus identityVerifiedAt selfPublished')
    .lean();
  if (!user) return null;

  // An unverified email proves nothing about who holds the address, so it is not
  // reported as a match at all.
  if (!user.emailVerified) return null;

  const verified = user.identityStatus === 'verified';
  return {
    verified,
    // Month precision only, and only when actually verified — a precise
    // timestamp is a correlatable fact the searcher has no need for.
    verifiedMonth: verified && user.identityVerifiedAt ? toMonth(user.identityVerifiedAt) : null,
    selfPublished: user.selfPublished ?? [],
  };
}

/** Coarsen a timestamp to "YYYY-MM", the only precision search ever reveals. */
function toMonth(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Run a search.
 *
 * Audited unconditionally, including searches that return nothing: a pattern of
 * lookups is exactly the abuse signal worth having, and it only exists if the
 * misses are recorded too.
 */
export async function search(params: {
  input: SearchInput;
  context: AuditContext;
}): Promise<SearchResult> {
  const identifier = soleIdentifier(params.input);
  const hash = hashIdentifier(identifier.type, identifier.value);

  const [account, subject] = await Promise.all([
    resolveAccount(identifier),
    SubjectProfile.findOne({ 'identifiers.hash': hash }).select('_id notifiedAt').lean(),
  ]);

  const records = subject
    ? await disclosableRecords({ subjectId: subject._id, subjectNotifiedAt: subject.notifiedAt ?? null })
    : [];

  // The identifier is recorded as a hash, never as its plaintext. The hash is
  // stable, so repeated probing of one person is still detectable in the log.
  await recordAudit('search.performed', {
    context: params.context,
    targetType: 'SubjectProfile',
    targetId: subject?._id.toString(),
    meta: {
      identifierType: identifier.type,
      identifierHash: hash,
      accountMatched: account !== null,
      recordsDisclosed: records.length,
    },
  });

  if (account === null && records.length === 0) {
    // Indistinguishable from an unknown identifier — see emptyResult().
    return emptyResult();
  }

  for (const record of records) {
    await recordAudit('search.record_disclosed', {
      context: params.context,
      targetType: 'Decision',
      targetId: record.decisionId,
      meta: { identifierHash: hash, category: record.category },
    });
  }

  return {
    matched: true,
    account,
    records: records.map(({ decisionId: _decisionId, ...visible }) => visible),
    disclaimer: SEARCH_DISCLAIMER,
  };
}

/**
 * Every decision about this subject that the publication gate permits us to
 * disclose, and nothing else.
 *
 * `decisionId` rides along on each row so the caller can write a per-record
 * audit entry; it is stripped before the response is built, because a decision id
 * would let a searcher probe moderator-facing endpoints.
 */
async function disclosableRecords(params: {
  subjectId: Types.ObjectId;
  subjectNotifiedAt: Date | null;
}): Promise<Array<SearchResult['records'][number] & { decisionId: string }>> {
  const now = new Date();

  const candidates = await Decision.find({
    subjectId: params.subjectId,
    ...publishableCandidateFilter(now),
  }).select('_id reportId outcome publishable vacatedAt appealWindowEndsAt issuedAt');

  if (candidates.length === 0) return [];

  // Batch the two joins the gate needs rather than querying per candidate.
  const [reports, appeals] = await Promise.all([
    Report.find({ _id: { $in: candidates.map((d) => d.reportId) } })
      .select('_id category withdrawnAt')
      .lean(),
    Appeal.find({ decisionId: { $in: candidates.map((d) => d._id) } })
      .select('decisionId state')
      .lean(),
  ]);

  const reportById = new Map(reports.map((r) => [r._id.toString(), r]));
  const appealsByDecision = new Map<string, string[]>();
  for (const appeal of appeals) {
    const key = appeal.decisionId.toString();
    const list = appealsByDecision.get(key) ?? [];
    list.push(appeal.state);
    appealsByDecision.set(key, list);
  }

  const out: Array<SearchResult['records'][number] & { decisionId: string }> = [];

  for (const decision of candidates) {
    const report = reportById.get(decision.reportId.toString());
    // A candidate whose report we cannot read is not disclosed. Failing closed on
    // a missing join is the only safe default here.
    if (!report) continue;

    const appealStates = appealsByDecision.get(decision._id.toString()) ?? [];

    const verdict = evaluateDisclosure({
      outcome: decision.outcome,
      publishable: decision.publishable,
      vacatedAt: decision.vacatedAt ?? null,
      reportWithdrawnAt: report.withdrawnAt ?? null,
      subjectNotifiedAt: params.subjectNotifiedAt,
      appealWindowEndsAt: decision.appealWindowEndsAt,
      appealStates: appealStates as never,
      appealWindowDays: env.APPEAL_WINDOW_DAYS,
      now,
    });
    if (!verdict.disclosable) continue;

    out.push({
      decisionId: decision._id.toString(),
      category: report.category,
      // The gate has already established the outcome is 'upheld'; the literal
      // keeps the response type honest.
      outcome: 'upheld',
      decidedMonth: toMonth(decision.issuedAt),
      // Anything still pending was vetoed by the gate above, so an appeal that
      // exists here has been resolved one way or the other.
      appealStatus: appealStates.length > 0 ? 'exhausted' : 'none_filed',
    });
  }

  // Newest first, at month precision. Ordering by the coarsened value rather than
  // the raw timestamp avoids implying a precision the response does not carry.
  out.sort((a, b) => b.decidedMonth.localeCompare(a.decidedMonth));
  return out;
}
