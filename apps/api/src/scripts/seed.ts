/**
 * Development seed.
 *   npm run seed
 *
 * Builds a dataset that exercises every state the UI has to render, and — more
 * importantly — every state the *publication gate* has to refuse. A seed that
 * only produced happy-path data would let a regression in visibility.ts ship
 * unnoticed, because nothing on screen would look wrong.
 *
 * Two rules this file follows:
 *
 *  1. THE WORKFLOW IS DRIVEN THROUGH THE SERVICES. Reports are filed, cases
 *     assigned, decisions issued and appeals resolved by calling the same
 *     functions the HTTP routes call. So the seed also acts as a smoke test of
 *     the domain layer: if an invariant is broken, seeding fails loudly instead
 *     of writing data no route could ever have produced.
 *
 *  2. IT MOVES THE CLOCK, NOT THE GATE. A record can only be searchable once an
 *     appeal window has elapsed, which real time will not do during a seed. So
 *     timestamps are back-dated — `issuedAt`, `appealWindowEndsAt`,
 *     `notifiedAt` — and the gate is then asked, unmodified, what it thinks.
 *     Nothing here sets a "visible" flag or bypasses `evaluateDisclosure`; the
 *     summary at the end prints the gate's own verdict for every decision, so a
 *     seed that claims a record is public is a seed in which the gate agreed.
 */
import { hash as argonHash } from '@node-rs/argon2';
import { Types } from 'mongoose';
import {
  isGraveCategory,
  type ReportCategory,
  type Role,
} from '@safecheck/shared';
import { connectDatabase, disconnectDatabase, mongoose } from '../db/connection.js';
import { env, isProd } from '../config/env.js';
import {
  Appeal,
  AuditLog,
  Decision,
  Evidence,
  ModerationCase,
  Notification,
  Otp,
  Report,
  Session,
  SubjectProfile,
  User,
  type ReportDoc,
} from '../models/index.js';
import { evaluateDisclosure } from '../domain/visibility.js';
import type { AuditContext } from '../services/audit.service.js';
import * as reportService from '../modules/reports/report.service.js';
import * as moderationService from '../modules/moderation/moderation.service.js';
import * as appealService from '../modules/appeals/appeal.service.js';
import { createNotification } from '../modules/notifications/notification.service.js';

/** Same argon2id parameters as the auth service; see the comment there. */
const ARGON_OPTIONS = {
  algorithm: 2 as const,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** One password for every seeded account. Meets the shared password policy. */
const SEED_PASSWORD = 'SafeCheck2026!';

const MS_PER_DAY = 86_400_000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * MS_PER_DAY);

/**
 * A synthetic audit context. Seeded rows are attributed to the actor that would
 * have performed them, with no IP — there was no request, and inventing one
 * would put fiction in an append-only log.
 */
function ctx(actorId: Types.ObjectId | string, actorRole: Role): AuditContext {
  return { actorId: actorId.toString(), actorRole, ipHash: null, userAgent: 'seed-script' };
}

/* ------------------------------------------------------------------- people */

interface SeedPerson {
  key: string;
  email: string;
  name: string;
  role: Role;
  /** Identity-verified account holders show a verified badge in search. */
  identityVerified?: boolean;
  selfPublished?: string[];
}

const PEOPLE: SeedPerson[] = [
  { key: 'admin', email: 'admin@safecheck.local', name: 'Amara Osei', role: 'admin' },
  { key: 'mod1', email: 'mod1@safecheck.local', name: 'Rafiq Chowdhury', role: 'moderator' },
  { key: 'mod2', email: 'mod2@safecheck.local', name: 'Lena Petrova', role: 'moderator' },
  { key: 'aisha', email: 'aisha@example.com', name: 'Aisha Rahman', role: 'user' },
  { key: 'ben', email: 'ben@example.com', name: 'Ben Alvarez', role: 'user' },
  {
    key: 'dana',
    email: 'dana@example.com',
    name: 'Dana Whitfield',
    role: 'user',
    identityVerified: true,
    selfPublished: ['Verified government ID', 'Verified phone number'],
  },
  { key: 'erik', email: 'erik@example.com', name: 'Erik Lindqvist', role: 'user' },
];

/**
 * Accounts are written directly rather than through `registerUser`, because that
 * path deliberately leaves an account unverified until an emailed OTP is
 * consumed. Seeding a mailbox round-trip would add nothing: the seed's purpose is
 * the *post*-signup states.
 */
async function createPeople(): Promise<Map<string, Types.ObjectId>> {
  const passwordHash = await argonHash(SEED_PASSWORD, ARGON_OPTIONS);
  const ids = new Map<string, Types.ObjectId>();

  for (const person of PEOPLE) {
    const user = await User.create({
      email: person.email,
      name: person.name,
      passwordHash,
      role: person.role,
      emailVerified: true,
      identityStatus: person.identityVerified ? 'verified' : 'unverified',
      identityVerifiedAt: person.identityVerified ? daysAgo(120) : null,
      selfPublished: person.selfPublished ?? [],
    });
    ids.set(person.key, user._id);
  }

  return ids;
}

/* ------------------------------------------------------------------ reports */

interface FileParams {
  reporter: Types.ObjectId;
  subjectEmail?: string;
  subjectPhone?: string;
  knownAs: string;
  category: ReportCategory;
  description: string;
  incidentDaysAgo: number;
  location: string;
  submit?: boolean;
}

/** File a report through the report service, exactly as the route would. */
async function fileReport(p: FileParams): Promise<ReportDoc> {
  return reportService.createReport({
    reporterId: p.reporter.toString(),
    input: {
      category: p.category,
      subject: {
        ...(p.subjectEmail ? { email: p.subjectEmail } : {}),
        ...(p.subjectPhone ? { phone: p.subjectPhone } : {}),
        knownAs: p.knownAs,
      },
      description: p.description,
      incidentAt: daysAgo(p.incidentDaysAgo).toISOString(),
      location: p.location,
      attestation: true,
      submitNow: p.submit ?? true,
    },
    context: ctx(p.reporter, 'user'),
  });
}

/** The open moderation case for a submitted report. */
async function caseFor(report: ReportDoc) {
  const kase = await ModerationCase.findOne({ reportId: report._id });
  if (!kase) throw new Error(`no moderation case for report ${report._id.toString()}`);
  return moderationService.loadCase(kase._id.toString());
}

/**
 * Take a report all the way to a decision: assign, investigate, decide.
 *
 * `issuer` must be a moderator. For grave categories the publication step later
 * requires a *different* moderator, which is the two-person rule — see
 * moderation.service.ts#setDecisionPublishable.
 */
async function decide(params: {
  report: ReportDoc;
  issuer: Types.ObjectId;
  outcome: 'upheld' | 'not_upheld' | 'insufficient_evidence' | 'out_of_scope' | 'referred';
  rationale: string;
  note?: string;
}) {
  const issuerCtx = ctx(params.issuer, 'moderator');
  let kase = await caseFor(params.report);

  kase = await moderationService.assignCase({
    kase,
    actorId: params.issuer.toString(),
    actorRole: 'moderator',
    context: issuerCtx,
  });

  kase = await moderationService.setCaseState({
    kase,
    to: 'investigating',
    actorId: params.issuer.toString(),
    actorRole: 'moderator',
    context: issuerCtx,
  });

  if (params.note) {
    kase = await moderationService.addCaseNote({
      kase,
      actorId: params.issuer.toString(),
      actorRole: 'moderator',
      input: { body: params.note, visibility: 'internal' },
      context: issuerCtx,
    });
  }

  return moderationService.issueDecision({
    kase,
    actorId: params.issuer.toString(),
    actorRole: 'moderator',
    input: {
      outcome: params.outcome,
      rationale: params.rationale,
      acknowledgeSubjectNotification: true,
    },
    context: issuerCtx,
  });
}

/**
 * Rewind a decision's clock so its appeal window has genuinely elapsed.
 *
 * This is the only place the seed writes timestamps behind the services' backs,
 * and it writes nothing the gate treats as permission — only the dates the gate
 * compares against. The subject's `notifiedAt` is moved too, because the gate
 * gives a late-notified subject a full window measured from notification, so
 * back-dating the decision alone would still (correctly) block disclosure.
 */
async function backdateDecision(decisionId: Types.ObjectId, issuedDaysAgo: number): Promise<void> {
  const issuedAt = daysAgo(issuedDaysAgo);
  const windowEnd = new Date(issuedAt.getTime() + env.APPEAL_WINDOW_DAYS * MS_PER_DAY);

  await Decision.updateOne(
    { _id: decisionId },
    { $set: { issuedAt, appealWindowEndsAt: windowEnd, createdAt: issuedAt } },
    { timestamps: false },
  );

  const decision = await Decision.findById(decisionId).select('subjectId').lean();
  if (decision) {
    await SubjectProfile.updateOne(
      { _id: decision.subjectId, notifiedAt: { $ne: null } },
      { $set: { notifiedAt: issuedAt } },
      { timestamps: false },
    );
  }
}

/* -------------------------------------------------------------- the dataset */

interface Scenario {
  label: string;
  /** What this row is here to prove, printed in the summary. */
  demonstrates: string;
  decisionId?: Types.ObjectId;
}

async function buildDataset(ids: Map<string, Types.ObjectId>): Promise<Scenario[]> {
  const id = (key: string): Types.ObjectId => {
    const value = ids.get(key);
    if (!value) throw new Error(`seed person "${key}" was not created`);
    return value;
  };

  const scenarios: Scenario[] = [];

  /* ── 1. A record the gate agrees is searchable ─────────────────────────────
   * Grave category, so publication needed two moderators: mod1 issued, mod2
   * approved. Back-dated past the appeal window with the subject notified. */
  {
    const report = await fileReport({
      reporter: id('aisha'),
      subjectEmail: 'dana@example.com',
      knownAs: 'Dana W.',
      category: 'stalking',
      description:
        'Followed me from the university library to my bus stop on four separate evenings over ' +
        'two weeks. On the fourth occasion he waited outside the stop until my bus arrived. I have ' +
        'timestamped photographs from two of those evenings and a message in which he refers to a ' +
        'route I never told him about.',
      incidentDaysAgo: 75,
      location: 'Dhanmondi, Dhaka',
    });

    const decision = await decide({
      report,
      issuer: id('mod1'),
      outcome: 'upheld',
      rationale:
        'The photographs establish presence at the same location on the dates given, and the ' +
        'message corroborates knowledge of the reporter\'s route that was not shared with the ' +
        'subject. The subject was invited to respond and did not dispute the timeline.',
      note: 'Two evenings independently corroborated by photo metadata. Escalating for publication review.',
    });

    // Publication is a second human's decision, and for a grave category it must
    // not be the moderator who decided. mod2 signs off.
    await moderationService.setDecisionPublishable({
      decisionId: decision._id.toString(),
      actorId: id('mod2').toString(),
      actorRole: 'moderator',
      input: {
        publishable: true,
        reviewNote:
          'Independent review: evidence supports the finding, subject had a full opportunity to ' +
          'respond, category warrants a searchable record.',
      },
      context: ctx(id('mod2'), 'moderator'),
    });

    await backdateDecision(decision._id, env.APPEAL_WINDOW_DAYS + 20);

    scenarios.push({
      label: 'stalking / Dana W.',
      demonstrates: 'searchable: upheld, two-moderator sign-off, window elapsed, subject notified',
      decisionId: decision._id,
    });
  }

  /* ── 2. Approved for publication, window still open ────────────────────────
   * Non-grave, so one moderator could approve it. The gate still refuses,
   * because the subject's right of reply has not expired. */
  {
    const report = await fileReport({
      reporter: id('ben'),
      subjectEmail: 'dana@example.com',
      knownAs: 'Dana W.',
      category: 'fraud',
      description:
        'Took a BDT 40,000 deposit for a flat viewing that never happened, then stopped replying. ' +
        'I have the bank transfer receipt and the full message thread in which the deposit was ' +
        'requested and acknowledged.',
      incidentDaysAgo: 20,
      location: 'Gulshan, Dhaka',
    });

    const decision = await decide({
      report,
      issuer: id('mod1'),
      outcome: 'upheld',
      rationale:
        'The transfer receipt and message thread together establish that a deposit was requested, ' +
        'received and not returned, and no viewing took place. The subject did not respond to two ' +
        'requests for comment.',
    });

    await moderationService.setDecisionPublishable({
      decisionId: decision._id.toString(),
      actorId: id('mod2').toString(),
      actorRole: 'moderator',
      input: { publishable: true, reviewNote: 'Documentary evidence is unambiguous.' },
      context: ctx(id('mod2'), 'moderator'),
    });

    scenarios.push({
      label: 'fraud / Dana W.',
      demonstrates: 'blocked: approved for publication, but the appeal window is still open',
      decisionId: decision._id,
    });
  }

  /* ── 3. Approved, then appealed ────────────────────────────────────────────
   * The window has elapsed, so only the pending appeal stands between this
   * record and disclosure. That single veto is the point of the row. */
  {
    const report = await fileReport({
      reporter: id('aisha'),
      subjectEmail: 'erik@example.com',
      knownAs: 'Erik L.',
      category: 'harassment',
      description:
        'Sent 60+ messages over nine days after I asked him twice to stop contacting me, including ' +
        'messages to my work address after I blocked his personal number. Screenshots attached ' +
        'cover the full sequence.',
      incidentDaysAgo: 60,
      location: 'Remote / online',
    });

    const decision = await decide({
      report,
      issuer: id('mod2'),
      outcome: 'upheld',
      rationale:
        'The message volume and the continuation after an explicit request to stop are both ' +
        'documented. Contacting a work address after being blocked is an escalation the subject ' +
        'does not deny.',
    });

    await moderationService.setDecisionPublishable({
      decisionId: decision._id.toString(),
      actorId: id('mod1').toString(),
      actorRole: 'moderator',
      input: { publishable: true, reviewNote: 'Reviewed independently; finding stands.' },
      context: ctx(id('mod1'), 'moderator'),
    });

    // Back-date first, then appeal — otherwise the appeal service would refuse a
    // filing after the deadline, which is exactly the behaviour we want kept.
    await backdateDecision(decision._id, env.APPEAL_WINDOW_DAYS - 2);

    const appeal = await appealService.fileAppeal({
      reportId: report._id.toString(),
      actorId: id('erik').toString(),
      input: {
        party: 'subject',
        grounds:
          'The message count includes replies to messages she sent me, and the work address was ' +
          'one she gave me herself. I was never shown the screenshots before the decision.',
      },
      context: ctx(id('erik'), 'user'),
    });

    // Reviewed by mod1 — not mod2, who issued the decision. The service enforces
    // that independence; claiming it here just exercises the path.
    await appealService.claimAppeal({
      appeal,
      actorId: id('mod1').toString(),
      context: ctx(id('mod1'), 'moderator'),
    });

    scenarios.push({
      label: 'harassment / Erik L.',
      demonstrates: 'blocked: an appeal is pending, so the record cannot be disclosed',
      decisionId: decision._id,
    });
  }

  /* ── 4. Decided, not upheld ────────────────────────────────────────────────
   * A private outcome that no gate condition could ever make searchable. The
   * subject is phone-only, so they are also unnotifiable — the gate blocks on
   * that independently, which is the fail-closed behaviour we want visible. */
  {
    const report = await fileReport({
      reporter: id('ben'),
      subjectPhone: '+8801711000111',
      knownAs: 'Unknown caller',
      category: 'unwanted_contact',
      description:
        'Repeated calls from an unknown number over three days, at least twelve in total, with no ' +
        'message left. I do not know who this is and have no screenshots beyond my call log.',
      incidentDaysAgo: 40,
      location: 'Chattogram',
    });

    const decision = await decide({
      report,
      issuer: id('mod2'),
      outcome: 'insufficient_evidence',
      rationale:
        'A call log alone does not establish who placed the calls or that contact was unwanted in a ' +
        'way the platform can assess. No finding is made against anyone, and nothing is recorded ' +
        'against the number.',
      note: 'No identifiable subject. Closing without a finding.',
    });

    scenarios.push({
      label: 'unwanted_contact / unknown caller',
      demonstrates: 'never searchable: not upheld, and an unreachable subject cannot be notified',
      decisionId: decision._id,
    });
  }

  /* ── 5. A vacated decision ─────────────────────────────────────────────────
   * Granted appeal → decision vacated, report back under review. The record on
   * the vacated decision is deliberately kept: it is the appeal trail. */
  {
    const report = await fileReport({
      reporter: id('ben'),
      subjectEmail: 'erik@example.com',
      knownAs: 'Erik L.',
      category: 'impersonation',
      description:
        'Someone created a profile using my photographs and my employer\'s name and messaged at ' +
        'least six of my colleagues. I have screenshots of the profile and two of the messages my ' +
        'colleagues received.',
      incidentDaysAgo: 90,
      location: 'Remote / online',
    });

    const decision = await decide({
      report,
      issuer: id('mod1'),
      outcome: 'upheld',
      rationale:
        'The profile reproduced the reporter\'s photographs and employer, and messages were sent to ' +
        'the reporter\'s colleagues from it.',
    });

    await backdateDecision(decision._id, env.APPEAL_WINDOW_DAYS - 3);

    const appeal = await appealService.fileAppeal({
      reportId: report._id.toString(),
      actorId: id('erik').toString(),
      input: {
        party: 'subject',
        grounds:
          'The account was not mine. The screenshots show a username that has never been ' +
          'associated with me, and I can show that I was not in the country on the dates the ' +
          'messages were sent.',
      },
      context: ctx(id('erik'), 'user'),
    });

    const claimed = await appealService.claimAppeal({
      appeal,
      actorId: id('mod2').toString(),
      context: ctx(id('mod2'), 'moderator'),
    });

    await appealService.resolveAppeal({
      appeal: claimed,
      actorId: id('mod2').toString(),
      input: {
        decision: 'granted',
        effect: 'vacate',
        rationale:
          'The subject produced travel records covering the dates in question and the account ' +
          'username does not match any identifier on file for them. The original finding cannot ' +
          'stand on this evidence. The report returns to review; nothing about the subject was ' +
          'ever disclosed.',
      },
      context: ctx(id('mod2'), 'moderator'),
    });

    scenarios.push({
      label: 'impersonation / Erik L.',
      demonstrates: 'vacated on appeal: can never be published, and the trail is preserved',
      decisionId: decision._id,
    });
  }

  /* ── 6. Live queue: submitted, unassigned ──────────────────────────────────
   * So the moderation queue isn't empty on first load. Grave, so it seeds at
   * high priority and sorts to the top. */
  await fileReport({
    reporter: id('aisha'),
    subjectPhone: '+8801812000222',
    knownAs: 'Neighbour, 4th floor',
    category: 'threats',
    description:
      'Told me on the stairwell that I would "regret" reporting the noise complaint and that he ' +
      'knows which floor I live on. Said in front of one witness who is willing to confirm it.',
    incidentDaysAgo: 3,
    location: 'Mirpur, Dhaka',
  });
  scenarios.push({
    label: 'threats / neighbour',
    demonstrates: 'queue: submitted, unassigned, seeded high priority because the category is grave',
  });

  /* ── 7. Live queue: assigned and under investigation ───────────────────── */
  {
    const report = await fileReport({
      reporter: id('ben'),
      subjectEmail: 'dana@example.com',
      knownAs: 'Dana W.',
      category: 'other',
      description:
        'Posted my home address in a public group chat of about 200 people after an argument about ' +
        'a parking space. The message was deleted after two hours but several people saw it.',
      incidentDaysAgo: 8,
      location: 'Banani, Dhaka',
    });

    let kase = await caseFor(report);
    kase = await moderationService.assignCase({
      kase,
      actorId: id('mod2').toString(),
      actorRole: 'moderator',
      context: ctx(id('mod2'), 'moderator'),
    });
    kase = await moderationService.setCaseState({
      kase,
      to: 'investigating',
      actorId: id('mod2').toString(),
      actorRole: 'moderator',
      context: ctx(id('mod2'), 'moderator'),
    });
    await moderationService.addCaseNote({
      kase,
      actorId: id('mod2').toString(),
      actorRole: 'moderator',
      input: {
        body: 'Asked the reporter whether anyone screenshotted the message before deletion.',
        visibility: 'internal',
      },
      context: ctx(id('mod2'), 'moderator'),
    });

    scenarios.push({
      label: 'other / Dana W.',
      demonstrates: 'queue: assigned to mod2, investigating, one internal note',
    });
  }

  /* ── 8. A draft, so the reporter's own list has one ──────────────────────── */
  await fileReport({
    reporter: id('aisha'),
    subjectEmail: 'erik@example.com',
    knownAs: 'Erik L.',
    category: 'unwanted_contact',
    description:
      'Draft — still collecting the screenshots. He has been messaging from new accounts each time ' +
      'I block one, and I want to attach the full set before I submit this.',
    incidentDaysAgo: 5,
    location: 'Remote / online',
    submit: false,
  });
  scenarios.push({
    label: 'unwanted_contact / Erik L. (draft)',
    demonstrates: 'draft: never entered the queue, editable by the reporter',
  });

  /* ── 9. A withdrawn report ──────────────────────────────────────────────── */
  {
    const report = await fileReport({
      reporter: id('ben'),
      subjectPhone: '+8801913000333',
      knownAs: 'Former colleague',
      category: 'harassment',
      description:
        'Repeated comments about my appearance in team meetings over roughly a month, after I asked ' +
        'him to stop once in private.',
      incidentDaysAgo: 30,
      location: 'Workplace',
    });

    await reportService.withdrawReport({
      report,
      actorId: id('ben').toString(),
      reason: 'Resolved directly through my employer and I would rather not pursue it here.',
      context: ctx(id('ben'), 'user'),
    });

    scenarios.push({
      label: 'harassment / former colleague',
      demonstrates: 'withdrawn by the reporter: permanently unpublishable',
    });
  }

  return scenarios;
}

/* ------------------------------------------------------------ notifications */

/**
 * A handful of in-app notifications. Bodies follow the rule in the notification
 * service: they say that something happened and where to look, never what was
 * alleged or what the outcome was.
 */
async function seedNotifications(ids: Map<string, Types.ObjectId>): Promise<number> {
  const rows: Array<Parameters<typeof createNotification>[0]> = [
    {
      userId: ids.get('aisha')!,
      type: 'decision.issued',
      title: 'A decision has been made',
      body: 'One of your reports has been reviewed. Sign in to read the decision.',
      href: '/reports',
    },
    {
      userId: ids.get('erik')!,
      type: 'subject.notified',
      title: 'A report concerns you',
      body: 'A report naming you has been decided. You can read it and respond.',
      href: '/reports',
    },
    {
      userId: ids.get('mod1')!,
      type: 'appeal.filed',
      title: 'An appeal needs a reviewer',
      body: 'An appeal is waiting to be claimed in the moderation queue.',
      href: '/moderation/appeals',
    },
    {
      userId: ids.get('mod2')!,
      type: 'case.assigned',
      title: 'A case was assigned to you',
      body: 'You have an open case in the moderation queue.',
      href: '/moderation',
    },
    {
      userId: ids.get('ben')!,
      type: 'appeal.resolved',
      title: 'An appeal has been resolved',
      body: 'An appeal on a report you filed has been decided. Sign in for details.',
      href: '/reports',
    },
  ];

  for (const row of rows) await createNotification(row);
  return rows.length;
}

/* ----------------------------------------------------------------- verify */

/**
 * Ask the gate — not the seed — what is actually disclosable, and report it.
 *
 * This runs the same evaluation the search service runs, on the data as written.
 * If the gate disagrees with a scenario's stated intent, that is a real finding
 * about the code, so it is printed rather than swallowed.
 */
async function verifyAgainstGate(scenarios: Scenario[]): Promise<string[]> {
  const lines: string[] = [];
  const now = new Date();

  for (const scenario of scenarios) {
    if (!scenario.decisionId) {
      lines.push(`  ·  ${scenario.label}\n       ${scenario.demonstrates}`);
      continue;
    }

    const decision = await Decision.findById(scenario.decisionId).lean();
    if (!decision) throw new Error(`seeded decision ${scenario.decisionId.toString()} vanished`);

    const [report, subject, appeals] = await Promise.all([
      Report.findById(decision.reportId).select('withdrawnAt').lean(),
      SubjectProfile.findById(decision.subjectId).select('notifiedAt').lean(),
      Appeal.find({ decisionId: decision._id }).select('state').lean(),
    ]);

    const verdict = evaluateDisclosure({
      outcome: decision.outcome,
      publishable: decision.publishable ?? false,
      vacatedAt: decision.vacatedAt ?? null,
      reportWithdrawnAt: report?.withdrawnAt ?? null,
      subjectNotifiedAt: subject?.notifiedAt ?? null,
      appealWindowEndsAt: decision.appealWindowEndsAt,
      appealStates: appeals.map((a) => a.state),
      appealWindowDays: env.APPEAL_WINDOW_DAYS,
      now,
    });

    const mark = verdict.disclosable ? 'SEARCHABLE' : 'hidden';
    const why = verdict.disclosable ? '' : `  [${verdict.reasons.join(', ')}]`;
    lines.push(`  ${verdict.disclosable ? '►' : '·'}  ${scenario.label} — ${mark}${why}`);
    lines.push(`       ${scenario.demonstrates}`);
  }

  return lines;
}

/* -------------------------------------------------------------------- main */

/**
 * Every collection the seed truncates, as `deleteMany` thunks.
 *
 * Thunks rather than a model array: the models have distinct document types, so
 * a union-typed array loses the per-model filter type and `deleteMany({})` no
 * longer checks. Closing over each model keeps each call individually typed.
 */
const TRUNCATE: Array<() => Promise<unknown>> = [
  () => User.deleteMany({}),
  () => Session.deleteMany({}),
  () => Otp.deleteMany({}),
  () => SubjectProfile.deleteMany({}),
  () => Report.deleteMany({}),
  () => Evidence.deleteMany({}),
  () => ModerationCase.deleteMany({}),
  () => Decision.deleteMany({}),
  () => Appeal.deleteMany({}),
  () => Notification.deleteMany({}),
  () => AuditLog.deleteMany({}),
];

async function main(): Promise<void> {
  // A seed truncates collections. Refusing outright in production is cheaper
  // than any amount of care about what it then writes.
  if (isProd) {
    process.stderr.write('Refusing to seed with NODE_ENV=production.\n');
    process.exitCode = 1;
    return;
  }

  await connectDatabase();
  process.stdout.write(`seeding ${mongoose.connection.name} …\n\n`);

  for (const truncate of TRUNCATE) await truncate();

  const ids = await createPeople();
  const scenarios = await buildDataset(ids);
  const notifications = await seedNotifications(ids);

  const gateLines = await verifyAgainstGate(scenarios);
  const disclosable = gateLines.filter((l) => l.includes('SEARCHABLE')).length;
  const auditRows = await AuditLog.countDocuments({});

  const out = [
    'accounts (password for all: ' + SEED_PASSWORD + ')',
    ...PEOPLE.map((p) => `  ${p.email.padEnd(24)} ${p.role}`),
    '',
    'what the publication gate says about each seeded decision',
    ...gateLines,
    '',
    `reports        : ${await Report.countDocuments({})}`,
    `cases          : ${await ModerationCase.countDocuments({})}`,
    `decisions      : ${await Decision.countDocuments({})}  (${disclosable} searchable)`,
    `appeals        : ${await Appeal.countDocuments({})}`,
    `notifications  : ${notifications}`,
    `audit rows     : ${auditRows}`,
    '',
    'search dana@example.com to see the one published record;',
    'sign in as mod1@safecheck.local for the queue.',
    '',
  ];

  process.stdout.write(out.join('\n'));
  await disconnectDatabase();
}

try {
  await main();
} catch (err) {
  process.stderr.write(`\nseed failed: ${(err as Error).message}\n${(err as Error).stack ?? ''}\n`);
  await disconnectDatabase().catch(() => {});
  process.exitCode = 1;
}
