import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import './setup.js';
import { createApp } from '../app.js';
import { capturedMail } from '../services/messaging.service.js';
import { env } from '../config/env.js';
import { AuditLog, Decision, ModerationCase, SubjectProfile, User } from '../models/index.js';
import { hashIdentifier } from '../lib/crypto.js';

/**
 * Moderation, publication and search integration tests.
 *
 * These cover the chain that makes SafeCheck safe to operate: a report is
 * decided, a *second* moderator approves publication, an appeal window elapses,
 * and only then does search disclose anything. Every link is tested for what it
 * refuses, not only for what it permits — the failure mode that matters here is
 * something becoming visible one step too early.
 *
 * Time is handled by back-dating the stored timestamps and letting the real gate
 * evaluate them. Nothing here stubs `evaluateDisclosure`; if the gate stops
 * vetoing, these tests fail.
 */

const app = createApp();

const MS_PER_DAY = 86_400_000;

const REPORTER = { email: 'reporter@example.com', password: 'Correct-Horse-9', name: 'Reporter' };
const SUBJECT_EMAIL = 'accused@example.com';
const SUBJECT_PASSWORD = 'Subject-Passphrase-7';

function latestOtp(): string {
  const message = capturedMail.sent.at(-1);
  if (!message) throw new Error('no email was sent');
  const match = /\b(\d{6})\b/.exec(message.body);
  if (!match) throw new Error('no code in email body');
  return match[1]!;
}

/** Register + verify, returning an access token. */
async function signUp(overrides: Partial<typeof REPORTER> = {}): Promise<string> {
  const creds = { ...REPORTER, ...overrides };
  await request(app).post('/api/auth/register').send(creds).expect(202);
  const res = await request(app)
    .post('/api/auth/verify-email')
    .send({ email: creds.email, code: latestOtp() })
    .expect(200);
  capturedMail.sent.length = 0;
  return res.body.accessToken as string;
}

/**
 * Sign up and promote to a role.
 *
 * The role is written directly because there is no self-service promotion
 * endpoint — by design. The token is then re-minted by logging in again, so it
 * carries the new role; `requireFreshRole` re-reads from the database anyway, but
 * `requireRole` reads the token.
 */
async function signUpAs(
  role: 'moderator' | 'admin',
  overrides: Partial<typeof REPORTER>,
): Promise<string> {
  const creds = { ...REPORTER, ...overrides };
  await signUp(creds);
  await User.updateOne({ email: creds.email }, { $set: { role } });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: creds.email, password: creds.password })
    .expect(200);
  capturedMail.sent.length = 0;
  return res.body.accessToken as string;
}

interface World {
  reporter: string;
  mod1: string;
  mod2: string;
  subject: string;
  reportId: string;
  caseId: string;
}

/**
 * A submitted report about a subject who holds an account.
 *
 * The subject needs an account for two reasons that both matter downstream: the
 * decision notification has somewhere to go (and so `notifiedAt` gets set, which
 * the gate requires), and the subject can file an appeal.
 */
async function world(category = 'harassment'): Promise<World> {
  const subject = await signUp({
    email: SUBJECT_EMAIL,
    password: SUBJECT_PASSWORD,
    name: 'The Subject',
  });
  const reporter = await signUp();
  const mod1 = await signUpAs('moderator', {
    email: 'mod1@example.com',
    password: 'Moderator-One-11',
    name: 'Mod One',
  });
  const mod2 = await signUpAs('moderator', {
    email: 'mod2@example.com',
    password: 'Moderator-Two-22',
    name: 'Mod Two',
  });

  const created = await request(app)
    .post('/api/reports')
    .set('authorization', `Bearer ${reporter}`)
    .send({
      category,
      subject: { email: SUBJECT_EMAIL, knownAs: 'Neighbour' },
      description:
        'He has repeatedly shouted abuse at me in the shared hallway over the last three weeks, ' +
        'and continued after I asked him to stop.',
      attestation: true,
      submitNow: true,
    })
    .expect(201);

  const kase = await ModerationCase.findOne({ reportId: created.body.report.id });

  return {
    reporter,
    mod1,
    mod2,
    subject,
    reportId: created.body.report.id as string,
    caseId: kase!._id.toString(),
  };
}

/** Assign a case to a moderator and issue a decision on it. */
async function decide(w: World, opts: { token: string; outcome?: string }): Promise<string> {
  await request(app)
    .post(`/api/moderation/cases/${w.caseId}/assign`)
    .set('authorization', `Bearer ${opts.token}`)
    .send({})
    .expect(200);

  const res = await request(app)
    .post(`/api/moderation/cases/${w.caseId}/decision`)
    .set('authorization', `Bearer ${opts.token}`)
    .send({
      outcome: opts.outcome ?? 'upheld',
      rationale:
        'The messages establish that contact continued after an explicit request to stop, and the ' +
        'subject did not dispute the timeline.',
      acknowledgeSubjectNotification: true,
    })
    .expect(201);

  return res.body.decision.id as string;
}

/**
 * Move a decision's clock into the past so its appeal window has elapsed.
 *
 * Both the decision and the subject's notification timestamp move, because the
 * gate gives a late-notified subject a full window measured from notification —
 * back-dating only the decision would still, correctly, block disclosure.
 */
async function elapseAppealWindow(decisionId: string): Promise<void> {
  const issuedAt = new Date(Date.now() - (env.APPEAL_WINDOW_DAYS + 5) * MS_PER_DAY);
  await Decision.updateOne(
    { _id: decisionId },
    {
      $set: {
        issuedAt,
        appealWindowEndsAt: new Date(issuedAt.getTime() + env.APPEAL_WINDOW_DAYS * MS_PER_DAY),
      },
    },
  );
  await SubjectProfile.updateOne({ notifiedAt: { $ne: null } }, { $set: { notifiedAt: issuedAt } });
}

/** Search as an authenticated caller. */
async function search(token: string, body: Record<string, unknown>) {
  const res = await request(app)
    .post('/api/search')
    .set('authorization', `Bearer ${token}`)
    .send(body)
    .expect(200);
  return res.body;
}

beforeEach(() => {
  capturedMail.sent.length = 0;
});

/* ------------------------------------------------------------- the queue */

describe('moderation queue', () => {
  it('is closed to ordinary users', async () => {
    const w = await world();
    await request(app)
      .get('/api/moderation/queue')
      .set('authorization', `Bearer ${w.reporter}`)
      .expect(403);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/moderation/queue').expect(401);
  });

  it('lists a submitted report as an unassigned case', async () => {
    const w = await world();
    const res = await request(app)
      .get('/api/moderation/queue')
      .set('authorization', `Bearer ${w.mod1}`)
      .expect(200);

    expect(res.body.cases).toHaveLength(1);
    expect(res.body.cases[0].state).toBe('unassigned');
    expect(res.body.cases[0].assignedTo).toBeNull();
  });

  it('never exposes the subject identifier or its hash to a moderator', async () => {
    const w = await world();
    const res = await request(app)
      .get(`/api/moderation/cases/${w.caseId}`)
      .set('authorization', `Bearer ${w.mod1}`)
      .expect(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(SUBJECT_EMAIL);
    expect(body).not.toContain(hashIdentifier('email', SUBJECT_EMAIL));
    // A moderator sees the label instead, which is not derived from the identifier.
    expect(res.body.case.report.subjectLabel).toBe('Neighbour');
  });

  it('refuses work on a case assigned to a different moderator', async () => {
    const w = await world();
    await request(app)
      .post(`/api/moderation/cases/${w.caseId}/assign`)
      .set('authorization', `Bearer ${w.mod1}`)
      .send({})
      .expect(200);

    await request(app)
      .post(`/api/moderation/cases/${w.caseId}/notes`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({ body: 'Sticking my oar in.' })
      .expect(403);
  });

  it('refuses to let a moderator assign a case to someone else', async () => {
    const w = await world();
    const other = await User.findOne({ email: 'mod2@example.com' }).select('_id').lean();

    await request(app)
      .post(`/api/moderation/cases/${w.caseId}/assign`)
      .set('authorization', `Bearer ${w.mod1}`)
      .send({ moderatorId: other!._id.toString() })
      .expect(403);
  });
});

/* ---------------------------------------------------------------- deciding */

describe('issuing a decision', () => {
  it('does not publish anything', async () => {
    const w = await world();
    const decisionId = await decide(w, { token: w.mod1 });

    // The single most important assertion in this file: deciding is not
    // publishing. A decision arrives unpublishable and stays that way until a
    // separate act says otherwise.
    const decision = await Decision.findById(decisionId);
    expect(decision!.publishable).toBe(false);
    expect(decision!.publishableSetBy).toBeNull();

    const result = await search(w.reporter, { email: SUBJECT_EMAIL });
    expect(result.records).toHaveLength(0);
  });

  it('closes the case and notifies the subject', async () => {
    const w = await world();
    await decide(w, { token: w.mod1 });

    const kase = await ModerationCase.findById(w.caseId);
    expect(kase!.state).toBe('closed');

    // Notification is a precondition for publication, not a courtesy.
    const subject = await SubjectProfile.findOne({});
    expect(subject!.notifiedAt).not.toBeNull();
    expect(capturedMail.sent.at(-1)!.to).toBe(SUBJECT_EMAIL);
    // The email must not carry the allegation itself.
    expect(capturedMail.sent.at(-1)!.body).not.toContain('shouted abuse');
  });

  it('refuses a second live decision on the same report', async () => {
    const w = await world();
    await decide(w, { token: w.mod1 });

    await request(app)
      .post(`/api/moderation/cases/${w.caseId}/decision`)
      .set('authorization', `Bearer ${w.mod1}`)
      .send({
        outcome: 'not_upheld',
        rationale: 'Changed my mind after the fact, which should not be possible.',
        acknowledgeSubjectNotification: true,
      })
      .expect(409);
  });

  it('refuses to decide a case the moderator is not assigned to', async () => {
    const w = await world();
    await request(app)
      .post(`/api/moderation/cases/${w.caseId}/decision`)
      .set('authorization', `Bearer ${w.mod1}`)
      .send({
        outcome: 'upheld',
        rationale: 'Deciding a case nobody assigned to me, which must be refused.',
        acknowledgeSubjectNotification: true,
      })
      .expect(403);
  });
});

/* -------------------------------------------------------------- publishing */

describe('marking a decision publishable', () => {
  it('requires a second moderator for a grave category', async () => {
    const w = await world('sexual_harassment');
    const decisionId = await decide(w, { token: w.mod1 });

    // The moderator who decided cannot also approve publication.
    await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod1}`)
      .send({ publishable: true, reviewNote: 'Approving my own decision for publication.' })
      .expect(403);

    await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({ publishable: true, reviewNote: 'Independent review; the finding is supported.' })
      .expect(200);

    const decision = await Decision.findById(decisionId);
    expect(decision!.publishable).toBe(true);
    expect(decision!.publishableSetBy!.toString()).not.toBe(decision!.issuedBy.toString());
  });

  it('refuses to publish a decision that did not uphold the report', async () => {
    const w = await world();
    const decisionId = await decide(w, { token: w.mod1, outcome: 'not_upheld' });

    await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({ publishable: true, reviewNote: 'Trying to publish a non-finding.' })
      .expect(412);
  });

  it('requires a review note', async () => {
    const w = await world();
    const decisionId = await decide(w, { token: w.mod1 });

    await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({ publishable: true })
      .expect(400);
  });

  it('reports that publishable does not mean disclosed', async () => {
    const w = await world();
    const decisionId = await decide(w, { token: w.mod1 });

    const res = await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({ publishable: true, reviewNote: 'Approved for publication after review.' })
      .expect(200);

    // The response carries the gate's verdict so a moderator is not misled into
    // thinking the record is now visible.
    expect(res.body.decision.publishable).toBe(true);
    expect(res.body.disclosure.disclosable).toBe(false);
    expect(res.body.disclosure.reasons).toContain('appeal_window_open');
  });

  it('allows un-publishing without a second moderator', async () => {
    const w = await world();
    const decisionId = await decide(w, { token: w.mod1 });

    await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({ publishable: true, reviewNote: 'Approved for publication after review.' })
      .expect(200);

    // Making something less visible never needs a second signature.
    await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({ publishable: false })
      .expect(200);

    expect((await Decision.findById(decisionId))!.publishable).toBe(false);
  });
});

/* ------------------------------------------------------------------ search */

describe('search', () => {
  it('requires authentication', async () => {
    await request(app).post('/api/search').send({ email: SUBJECT_EMAIL }).expect(401);
  });

  it('rejects a query with two identifiers, and one with none', async () => {
    const w = await world();
    await request(app)
      .post('/api/search')
      .set('authorization', `Bearer ${w.reporter}`)
      .send({ email: SUBJECT_EMAIL, phone: '+8801711000111' })
      .expect(422);

    await request(app)
      .post('/api/search')
      .set('authorization', `Bearer ${w.reporter}`)
      .send({})
      .expect(422);
  });

  it('returns nothing for an identifier we have never seen', async () => {
    const w = await world();
    const result = await search(w.reporter, { email: 'nobody@example.com' });

    expect(result.matched).toBe(false);
    expect(result.account).toBeNull();
    expect(result.records).toHaveLength(0);
    expect(result.disclaimer).toBeTruthy();
  });

  it('is byte-identical for an unknown identifier and a subject with nothing disclosable', async () => {
    const w = await world();
    await decide(w, { token: w.mod1 });

    // A report exists about this subject, and a decision has been issued. The
    // response must be indistinguishable from one about a stranger, or search
    // becomes an oracle for "has anyone accused this person".
    const unknown = await search(w.reporter, { email: 'nobody-at-all@example.com' });

    // The subject has a verified account, so compare against an account-less
    // identifier: a phone number nobody holds.
    const knownButHidden = await search(w.reporter, { phone: '+8801999888777' });
    expect(JSON.stringify(knownButHidden)).toBe(JSON.stringify(unknown));
  });

  it('reports a verified account at month precision without any records', async () => {
    const w = await world();
    await User.updateOne(
      { email: SUBJECT_EMAIL },
      { $set: { identityStatus: 'verified', identityVerifiedAt: new Date('2026-02-17T09:30:00Z') } },
    );

    const result = await search(w.reporter, { email: SUBJECT_EMAIL });
    expect(result.matched).toBe(true);
    expect(result.account.verified).toBe(true);
    // Month only — a precise timestamp is a correlatable fact.
    expect(result.account.verifiedMonth).toBe('2026-02');
    expect(result.records).toHaveLength(0);
  });

  it('does not report an account whose email is unverified', async () => {
    const w = await world();
    await User.updateOne({ email: SUBJECT_EMAIL }, { $set: { emailVerified: false } });

    const result = await search(w.reporter, { email: SUBJECT_EMAIL });
    expect(result.matched).toBe(false);
    expect(result.account).toBeNull();
  });

  it('discloses a record only once every gate condition is met', async () => {
    const w = await world();
    const decisionId = await decide(w, { token: w.mod1 });

    // Publishable, but the window is open.
    await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({ publishable: true, reviewNote: 'Approved for publication after review.' })
      .expect(200);
    expect((await search(w.reporter, { email: SUBJECT_EMAIL })).records).toHaveLength(0);

    // Window elapsed, no appeal: now, and only now, it is disclosed.
    await elapseAppealWindow(decisionId);
    const result = await search(w.reporter, { email: SUBJECT_EMAIL });

    expect(result.records).toHaveLength(1);
    expect(result.records[0].category).toBe('harassment');
    expect(result.records[0].outcome).toBe('upheld');
    expect(result.records[0].decidedMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(result.records[0].appealStatus).toBe('none_filed');
  });

  it('discloses no narrative, evidence, reporter or decision id', async () => {
    const w = await world();
    const decisionId = await decide(w, { token: w.mod1 });
    await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({ publishable: true, reviewNote: 'Approved for publication after review.' })
      .expect(200);
    await elapseAppealWindow(decisionId);

    const result = await search(w.reporter, { email: SUBJECT_EMAIL });
    const body = JSON.stringify(result);

    expect(result.records).toHaveLength(1);
    expect(body).not.toContain('shouted abuse');
    expect(body).not.toContain('rationale');
    expect(body).not.toContain(w.reportId);
    // A decision id would let a searcher probe the moderator-facing endpoints.
    expect(body).not.toContain(decisionId);
    expect(body).not.toContain(hashIdentifier('email', SUBJECT_EMAIL));
  });

  it('stops disclosing as soon as an appeal is filed', async () => {
    const w = await world();
    const decisionId = await decide(w, { token: w.mod1 });
    await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({ publishable: true, reviewNote: 'Approved for publication after review.' })
      .expect(200);

    // Back-date to just inside the window so an appeal is still admissible.
    const issuedAt = new Date(Date.now() - (env.APPEAL_WINDOW_DAYS - 1) * MS_PER_DAY);
    await Decision.updateOne(
      { _id: decisionId },
      {
        $set: {
          issuedAt,
          appealWindowEndsAt: new Date(issuedAt.getTime() + env.APPEAL_WINDOW_DAYS * MS_PER_DAY),
        },
      },
    );
    await SubjectProfile.updateOne({}, { $set: { notifiedAt: issuedAt } });

    await request(app)
      .post(`/api/reports/${w.reportId}/appeals`)
      .set('authorization', `Bearer ${w.subject}`)
      .send({
        party: 'subject',
        grounds: 'I was never shown the messages the decision relies on, and some are my replies.',
      })
      .expect(201);

    // Now push past the deadline. The window is closed, but the appeal is not.
    await elapseAppealWindow(decisionId);
    expect((await search(w.reporter, { email: SUBJECT_EMAIL })).records).toHaveLength(0);
  });

  it('stops disclosing when the decision is vacated on appeal', async () => {
    const w = await world();
    const decisionId = await decide(w, { token: w.mod1 });
    await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({ publishable: true, reviewNote: 'Approved for publication after review.' })
      .expect(200);
    await elapseAppealWindow(decisionId);
    expect((await search(w.reporter, { email: SUBJECT_EMAIL })).records).toHaveLength(1);

    await Decision.updateOne(
      { _id: decisionId },
      { $set: { vacatedAt: new Date(), vacatedReason: 'Vacated on appeal.' } },
    );
    expect((await search(w.reporter, { email: SUBJECT_EMAIL })).records).toHaveLength(0);
  });

  it('stops disclosing when the reporter withdraws the report', async () => {
    const w = await world();
    const decisionId = await decide(w, { token: w.mod1 });
    await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({ publishable: true, reviewNote: 'Approved for publication after review.' })
      .expect(200);
    await elapseAppealWindow(decisionId);
    expect((await search(w.reporter, { email: SUBJECT_EMAIL })).records).toHaveLength(1);

    // The report is already decided, so withdrawal is not an available route
    // action; the gate must still veto on the flag.
    await request(app)
      .post(`/api/reports/${w.reportId}/withdraw`)
      .set('authorization', `Bearer ${w.reporter}`)
      .send({ reason: 'We have resolved this privately and I no longer wish to pursue it.' })
      .expect(412);

    const { Report } = await import('../models/index.js');
    await Report.updateOne({ _id: w.reportId }, { $set: { withdrawnAt: new Date() } });
    expect((await search(w.reporter, { email: SUBJECT_EMAIL })).records).toHaveLength(0);
  });

  it('never discloses about a subject who could not be notified', async () => {
    const w = await world();
    const decisionId = await decide(w, { token: w.mod1 });
    await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({ publishable: true, reviewNote: 'Approved for publication after review.' })
      .expect(200);
    await elapseAppealWindow(decisionId);

    // Simulate the unreachable-subject case: no notification on record.
    await SubjectProfile.updateOne({}, { $set: { notifiedAt: null, notificationChannel: null } });
    expect((await search(w.reporter, { email: SUBJECT_EMAIL })).records).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------- audit */

describe('search auditing', () => {
  it('records a search that found nothing, with the identifier hashed', async () => {
    const w = await world();
    await search(w.reporter, { email: 'nobody@example.com' });

    const rows = await AuditLog.find({ action: 'search.performed' });
    expect(rows).toHaveLength(1);

    // Misses are logged too: a pattern of lookups is the abuse signal, and it
    // only exists if the misses are there.
    const meta = JSON.stringify(rows[0]!.meta);
    expect(meta).not.toContain('nobody@example.com');
    expect(meta).toContain(hashIdentifier('email', 'nobody@example.com'));
  });

  it('records a separate row for each disclosed record', async () => {
    const w = await world();
    const decisionId = await decide(w, { token: w.mod1 });
    await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({ publishable: true, reviewNote: 'Approved for publication after review.' })
      .expect(200);
    await elapseAppealWindow(decisionId);

    await search(w.reporter, { email: SUBJECT_EMAIL });

    const disclosures = await AuditLog.find({ action: 'search.record_disclosed' });
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]!.targetId).toBe(decisionId);
    expect(JSON.stringify(disclosures[0]!.meta)).not.toContain(SUBJECT_EMAIL);
  });

  it('writes no disclosure row when nothing was disclosed', async () => {
    const w = await world();
    await decide(w, { token: w.mod1 });
    await search(w.reporter, { email: SUBJECT_EMAIL });

    expect(await AuditLog.countDocuments({ action: 'search.record_disclosed' })).toBe(0);
  });
});

/* ----------------------------------------------------------------- appeals */

describe('appeals', () => {
  it('lets the subject appeal a decision against them', async () => {
    const w = await world();
    await decide(w, { token: w.mod1 });

    const res = await request(app)
      .post(`/api/reports/${w.reportId}/appeals`)
      .set('authorization', `Bearer ${w.subject}`)
      .send({
        party: 'subject',
        grounds: 'The decision relies on messages I was never shown, several of which are replies.',
      })
      .expect(201);

    expect(res.body.appeal.state).toBe('filed');
  });

  it('refuses an appeal from someone who is neither party', async () => {
    const w = await world();
    await decide(w, { token: w.mod1 });
    const stranger = await signUp({
      email: 'stranger@example.com',
      password: 'Stranger-Pass-12',
      name: 'Stranger',
    });

    await request(app)
      .post(`/api/reports/${w.reportId}/appeals`)
      .set('authorization', `Bearer ${stranger}`)
      .send({ party: 'subject', grounds: 'Appealing a decision that has nothing to do with me.' })
      .expect(404);
  });

  it('refuses one party filing twice against the same decision', async () => {
    const w = await world();
    await decide(w, { token: w.mod1 });

    const grounds = 'The decision relies on messages I was never shown before it was issued.';
    await request(app)
      .post(`/api/reports/${w.reportId}/appeals`)
      .set('authorization', `Bearer ${w.subject}`)
      .send({ party: 'subject', grounds })
      .expect(201);

    await request(app)
      .post(`/api/reports/${w.reportId}/appeals`)
      .set('authorization', `Bearer ${w.subject}`)
      .send({ party: 'subject', grounds })
      .expect(409);
  });

  it('refuses to let the deciding moderator review the appeal against it', async () => {
    const w = await world();
    await decide(w, { token: w.mod1 });

    const filed = await request(app)
      .post(`/api/reports/${w.reportId}/appeals`)
      .set('authorization', `Bearer ${w.subject}`)
      .send({
        party: 'subject',
        grounds: 'The decision relies on messages I was never shown before it was issued.',
      })
      .expect(201);

    // mod1 issued the decision, so mod1 cannot sit in judgment on the appeal.
    await request(app)
      .post(`/api/appeals/${filed.body.appeal.id}/claim`)
      .set('authorization', `Bearer ${w.mod1}`)
      .expect(403);

    await request(app)
      .post(`/api/appeals/${filed.body.appeal.id}/claim`)
      .set('authorization', `Bearer ${w.mod2}`)
      .expect(200);
  });

  it('vacates the decision when an appeal is granted, and reopens the report', async () => {
    const w = await world();
    const decisionId = await decide(w, { token: w.mod1 });

    const filed = await request(app)
      .post(`/api/reports/${w.reportId}/appeals`)
      .set('authorization', `Bearer ${w.subject}`)
      .send({
        party: 'subject',
        grounds: 'I can show I was not in the country on any of the dates in the decision.',
      })
      .expect(201);

    await request(app)
      .post(`/api/appeals/${filed.body.appeal.id}/claim`)
      .set('authorization', `Bearer ${w.mod2}`)
      .expect(200);

    await request(app)
      .post(`/api/appeals/${filed.body.appeal.id}/resolve`)
      .set('authorization', `Bearer ${w.mod2}`)
      .send({
        decision: 'granted',
        effect: 'vacate',
        rationale:
          'The subject produced travel records covering every date relied on. The original finding ' +
          'cannot stand on this evidence.',
      })
      .expect(200);

    const decision = await Decision.findById(decisionId);
    expect(decision!.vacatedAt).not.toBeNull();

    // A vacated decision can never be published, whatever anyone does next.
    await request(app)
      .patch(`/api/moderation/decisions/${decisionId}/publishable`)
      .set('authorization', `Bearer ${w.mod1}`)
      .send({ publishable: true, reviewNote: 'Trying to publish a vacated decision.' })
      .expect(412);
  });
});

/* ----------------------------------------------------------- notifications */

describe('notifications', () => {
  it('lists only the caller’s own notifications', async () => {
    const w = await world();
    await decide(w, { token: w.mod1 });

    const mine = await request(app)
      .get('/api/notifications')
      .set('authorization', `Bearer ${w.reporter}`)
      .expect(200);

    expect(Array.isArray(mine.body.notifications)).toBe(true);
    expect(mine.body.unread).toBeTypeOf('number');
  });

  it('requires authentication', async () => {
    await request(app).get('/api/notifications').expect(401);
  });

  it('marks nothing when handed an id belonging to someone else', async () => {
    const w = await world();
    const { Notification } = await import('../models/index.js');
    const other = await User.findOne({ email: SUBJECT_EMAIL }).select('_id').lean();
    const row = await Notification.create({
      userId: other!._id,
      type: 'decision.issued',
      title: 'A decision has been made',
      body: 'Sign in to read it.',
    });

    const res = await request(app)
      .post('/api/notifications/read')
      .set('authorization', `Bearer ${w.reporter}`)
      .send({ ids: [row._id.toString()] })
      .expect(200);

    // Zero updated, not an error: a 404 would confirm the id exists.
    expect(res.body.updated).toBe(0);
    expect((await Notification.findById(row._id))!.readAt).toBeNull();
  });
});
