import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import './setup.js';
import { createApp } from '../app.js';
import { capturedMail } from '../services/messaging.service.js';
import { AuditLog, Evidence, ModerationCase, Report, SubjectProfile } from '../models/index.js';
import { hashIdentifier } from '../lib/crypto.js';

/**
 * Reports + evidence integration tests.
 *
 * These run against the local encrypted storage driver (see vitest.config.ts),
 * so the encrypt → store → fetch → decrypt path is genuinely exercised without
 * touching Cloudinary.
 */

const app = createApp();

const REPORTER = {
  email: 'reporter@example.com',
  password: 'Correct-Horse-9',
  name: 'Test Reporter',
};

const SUBJECT_EMAIL = 'accused@example.com';

/** A 1×1 PNG — small, but with real magic bytes so sniffing succeeds. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

function latestOtp(): string {
  const message = capturedMail.sent.at(-1);
  if (!message) throw new Error('no email was sent');
  const match = /\b(\d{6})\b/.exec(message.body);
  if (!match) throw new Error('no code in email body');
  return match[1]!;
}

async function signUp(overrides: Partial<typeof REPORTER> = {}): Promise<string> {
  const creds = { ...REPORTER, ...overrides };
  await request(app).post('/api/auth/register').send(creds).expect(202);
  const res = await request(app)
    .post('/api/auth/verify-email')
    .send({ email: creds.email, code: latestOtp() })
    .expect(200);
  return res.body.accessToken as string;
}

function newReportBody(overrides: Record<string, unknown> = {}) {
  return {
    category: 'harassment',
    subject: { email: SUBJECT_EMAIL, knownAs: 'Neighbour' },
    description:
      'He has repeatedly shouted abuse at me in the shared hallway over the last three weeks.',
    attestation: true,
    submitNow: true,
    ...overrides,
  };
}

async function createReport(token: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/reports')
    .set('authorization', `Bearer ${token}`)
    .send(newReportBody(overrides))
    .expect(201);
  return res.body.report;
}

beforeEach(() => {
  capturedMail.sent.length = 0;
});

describe('creating a report', () => {
  it('files a report and opens a moderation case', async () => {
    const token = await signUp();
    const report = await createReport(token);

    expect(report.id).toBeTypeOf('string');
    expect(report.category).toBe('harassment');
    expect(report.status).toBe('submitted');
    expect(report.subjectLabel).toBe('Neighbour');

    // A submitted allegation always has a human owner.
    const kase = await ModerationCase.findOne({ reportId: report.id });
    expect(kase).not.toBeNull();
    expect(kase!.state).toBe('unassigned');
  });

  it('stores the subject only as a peppered hash, never in plaintext', async () => {
    const token = await signUp();
    await createReport(token);

    const subject = await SubjectProfile.findOne({});
    expect(subject).not.toBeNull();

    // The whole document must not contain the email anywhere.
    const serialised = JSON.stringify(subject!.toObject());
    expect(serialised).not.toContain(SUBJECT_EMAIL);
    expect(serialised).not.toContain('accused');

    // ...but the hash must be the deterministic one, so lookup still works.
    expect(subject!.identifiers).toHaveLength(1);
    expect(subject!.identifiers[0]!.hash).toBe(hashIdentifier('email', SUBJECT_EMAIL));
  });

  it('accumulates separate reports about one person onto a single subject', async () => {
    const first = await signUp();
    await createReport(first);

    capturedMail.sent.length = 0;
    const second = await signUp({ email: 'other@example.com', name: 'Other Reporter' });
    await createReport(second, { category: 'stalking' });

    // Two reports, one subject — matched purely by identifier hash.
    expect(await Report.countDocuments({})).toBe(2);
    expect(await SubjectProfile.countDocuments({})).toBe(1);
  });

  it('rejects a report with no attestation', async () => {
    const token = await signUp();
    const res = await request(app)
      .post('/api/reports')
      .set('authorization', `Bearer ${token}`)
      .send(newReportBody({ attestation: false }))
      .expect(422);
    expect(res.body.error.details.attestation).toBeDefined();
  });

  it('rejects a report with no way to identify the subject', async () => {
    const token = await signUp();
    await request(app)
      .post('/api/reports')
      .set('authorization', `Bearer ${token}`)
      .send(newReportBody({ subject: { knownAs: 'Someone' } }))
      .expect(422);
  });

  it('refuses a report filed against the reporter themselves', async () => {
    const token = await signUp();
    await request(app)
      .post('/api/reports')
      .set('authorization', `Bearer ${token}`)
      .send(newReportBody({ subject: { email: REPORTER.email } }))
      .expect(400);
  });

  it('requires authentication', async () => {
    await request(app).post('/api/reports').send(newReportBody()).expect(401);
  });

  it('saves a draft without opening a case when submitNow is false', async () => {
    const token = await signUp();
    const report = await createReport(token, { submitNow: false });

    expect(report.status).toBe('draft');
    expect(await ModerationCase.countDocuments({})).toBe(0);
  });
});

describe('report access control', () => {
  it('hides a report from an unrelated user, as a 404 not a 403', async () => {
    const owner = await signUp();
    const report = await createReport(owner);

    capturedMail.sent.length = 0;
    const stranger = await signUp({ email: 'stranger@example.com', name: 'Stranger' });

    // 403 would confirm the report exists, which is itself a disclosure.
    await request(app)
      .get(`/api/reports/${report.id}`)
      .set('authorization', `Bearer ${stranger}`)
      .expect(404);
  });

  it('lists only the requesting reporter’s own reports', async () => {
    const owner = await signUp();
    await createReport(owner);

    capturedMail.sent.length = 0;
    const stranger = await signUp({ email: 'stranger@example.com', name: 'Stranger' });

    const res = await request(app)
      .get('/api/reports')
      .set('authorization', `Bearer ${stranger}`)
      .expect(200);
    expect(res.body.reports).toHaveLength(0);
  });

  it('never exposes the subject’s identifier hash to the reporter', async () => {
    const token = await signUp();
    const report = await createReport(token);

    const res = await request(app)
      .get(`/api/reports/${report.id}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(hashIdentifier('email', SUBJECT_EMAIL));
    expect(body).not.toContain(SUBJECT_EMAIL);
  });
});

describe('report lifecycle', () => {
  it('blocks edits once submitted', async () => {
    const token = await signUp();
    const report = await createReport(token);

    await request(app)
      .patch(`/api/reports/${report.id}`)
      .set('authorization', `Bearer ${token}`)
      .send({ location: 'Rewritten after the fact' })
      .expect(412);
  });

  it('allows editing a draft, then submitting it', async () => {
    const token = await signUp();
    const draft = await createReport(token, { submitNow: false });

    await request(app)
      .patch(`/api/reports/${draft.id}`)
      .set('authorization', `Bearer ${token}`)
      .send({ location: 'Shared hallway, 2nd floor' })
      .expect(200);

    const res = await request(app)
      .post(`/api/reports/${draft.id}/submit`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.report.status).toBe('submitted');
  });

  it('withdraws a report and closes its case', async () => {
    const token = await signUp();
    const report = await createReport(token);

    const res = await request(app)
      .post(`/api/reports/${report.id}/withdraw`)
      .set('authorization', `Bearer ${token}`)
      .send({ reason: 'We have resolved this privately.' })
      .expect(200);

    expect(res.body.report.status).toBe('withdrawn');
    const kase = await ModerationCase.findOne({ reportId: report.id });
    expect(kase!.state).toBe('closed');
  });

  it('refuses to re-submit an already-submitted report', async () => {
    const token = await signUp();
    const report = await createReport(token);

    const before = await Report.findById(report.id);
    const originalSubmittedAt = before!.submittedAt!.getTime();

    // Already submitted; 'submitted' → 'submitted' is not a legal edge.
    await request(app)
      .post(`/api/reports/${report.id}/submit`)
      .set('authorization', `Bearer ${token}`)
      .expect(412);

    // The filing time must survive a retry, and the retry must not open a
    // second case. Previously both broke: submittedAt was rewritten and the
    // request failed only on the ModerationCase unique index.
    const after = await Report.findById(report.id);
    expect(after!.submittedAt!.getTime()).toBe(originalSubmittedAt);
    expect(await ModerationCase.countDocuments({ reportId: report.id })).toBe(1);
  });

  it('flags grave categories as high priority for the queue', async () => {
    const token = await signUp();
    const report = await createReport(token, { category: 'sexual_harassment' });

    const kase = await ModerationCase.findOne({ reportId: report.id });
    expect(kase!.grave).toBe(true);
    expect(kase!.priority).toBe('high');
  });

  it('does not mark ordinary categories as grave', async () => {
    const token = await signUp();
    const report = await createReport(token, { category: 'fraud' });

    const kase = await ModerationCase.findOne({ reportId: report.id });
    expect(kase!.grave).toBe(false);
    expect(kase!.priority).toBe('normal');
  });
});

describe('evidence', () => {
  it('uploads, encrypts at rest, and returns the exact bytes to the reporter', async () => {
    const token = await signUp();
    const report = await createReport(token);

    const uploaded = await request(app)
      .post(`/api/reports/${report.id}/evidence`)
      .set('authorization', `Bearer ${token}`)
      .attach('file', PNG, { filename: 'hallway.png', contentType: 'image/png' })
      .field('caption', 'Screenshot of the message')
      .expect(201);

    expect(uploaded.body.evidence.mime).toBe('image/png');
    expect(uploaded.body.evidence.kind).toBe('image');

    // The stored record must not leak the storage key to the client...
    expect(JSON.stringify(uploaded.body)).not.toContain('storageKey');

    // ...and what is on disk must be ciphertext, not the PNG.
    const stored = await Evidence.findById(uploaded.body.evidence.id);
    expect(stored!.encryption!.iv).toBeTruthy();
    expect(stored!.encryption!.authTag).toBeTruthy();
    expect(stored!.storageKey).not.toContain(report.id);

    // Round-trip through the authorised download path.
    const download = await request(app)
      .get(`/api/evidence/${uploaded.body.evidence.id}/content`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    expect(Buffer.from(download.body)).toEqual(PNG);
    // Must never render in-origin: that would make stored files an XSS vector.
    expect(download.headers['content-disposition']).toMatch(/^attachment/);
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['cache-control']).toMatch(/no-store/);
  });

  it('rejects a file whose real type is not on the allow-list', async () => {
    const token = await signUp();
    const report = await createReport(token);

    // Declared as a PNG, actually a Windows executable.
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x41)]);

    await request(app)
      .post(`/api/reports/${report.id}/evidence`)
      .set('authorization', `Bearer ${token}`)
      .attach('file', exe, { filename: 'innocent.png', contentType: 'image/png' })
      .expect(400);

    expect(await Evidence.countDocuments({})).toBe(0);
  });

  it('rejects an HTML file masquerading as an image', async () => {
    const token = await signUp();
    const report = await createReport(token);

    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>', 'utf8');

    await request(app)
      .post(`/api/reports/${report.id}/evidence`)
      .set('authorization', `Bearer ${token}`)
      .attach('file', html, { filename: 'photo.png', contentType: 'image/png' })
      .expect(400);
  });

  it('refuses evidence from someone who is not the reporter', async () => {
    const owner = await signUp();
    const report = await createReport(owner);

    capturedMail.sent.length = 0;
    const stranger = await signUp({ email: 'stranger@example.com', name: 'Stranger' });

    await request(app)
      .post(`/api/reports/${report.id}/evidence`)
      .set('authorization', `Bearer ${stranger}`)
      .attach('file', PNG, { filename: 'x.png', contentType: 'image/png' })
      .expect(404);
  });

  it('refuses to serve evidence to an unrelated user', async () => {
    const owner = await signUp();
    const report = await createReport(owner);
    const uploaded = await request(app)
      .post(`/api/reports/${report.id}/evidence`)
      .set('authorization', `Bearer ${owner}`)
      .attach('file', PNG, { filename: 'x.png', contentType: 'image/png' })
      .expect(201);

    capturedMail.sent.length = 0;
    const stranger = await signUp({ email: 'stranger@example.com', name: 'Stranger' });

    await request(app)
      .get(`/api/evidence/${uploaded.body.evidence.id}/content`)
      .set('authorization', `Bearer ${stranger}`)
      .expect(404);
  });

  it('requires authentication to fetch evidence', async () => {
    const token = await signUp();
    const report = await createReport(token);
    const uploaded = await request(app)
      .post(`/api/reports/${report.id}/evidence`)
      .set('authorization', `Bearer ${token}`)
      .attach('file', PNG, { filename: 'x.png', contentType: 'image/png' })
      .expect(201);

    await request(app)
      .get(`/api/evidence/${uploaded.body.evidence.id}/content`)
      .expect(401);
  });

  it('writes an audit row for every evidence access', async () => {
    const token = await signUp();
    const report = await createReport(token);
    const uploaded = await request(app)
      .post(`/api/reports/${report.id}/evidence`)
      .set('authorization', `Bearer ${token}`)
      .attach('file', PNG, { filename: 'x.png', contentType: 'image/png' })
      .expect(201);

    await request(app)
      .get(`/api/evidence/${uploaded.body.evidence.id}/content`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    const accesses = await AuditLog.find({ action: 'evidence.accessed' });
    expect(accesses).toHaveLength(1);
    expect(accesses[0]!.targetId).toBe(uploaded.body.evidence.id);
    // The IP is recorded only as a hash.
    expect(accesses[0]!.ipHash).not.toContain('.');
  });

  it('does not record the filename in the upload audit row', async () => {
    const token = await signUp();
    const report = await createReport(token);

    await request(app)
      .post(`/api/reports/${report.id}/evidence`)
      .set('authorization', `Bearer ${token}`)
      .attach('file', PNG, {
        filename: 'him-threatening-to-kill-me.png',
        contentType: 'image/png',
      })
      .expect(201);

    const row = await AuditLog.findOne({ action: 'evidence.uploaded' });
    expect(JSON.stringify(row!.meta)).not.toContain('threatening');
  });

  it('blocks evidence on a withdrawn report', async () => {
    const token = await signUp();
    const report = await createReport(token);

    await request(app)
      .post(`/api/reports/${report.id}/withdraw`)
      .set('authorization', `Bearer ${token}`)
      .send({ reason: 'Resolved privately.' })
      .expect(200);

    await request(app)
      .post(`/api/reports/${report.id}/evidence`)
      .set('authorization', `Bearer ${token}`)
      .attach('file', PNG, { filename: 'x.png', contentType: 'image/png' })
      .expect(412);
  });

  it('rejects an empty file', async () => {
    const token = await signUp();
    const report = await createReport(token);

    await request(app)
      .post(`/api/reports/${report.id}/evidence`)
      .set('authorization', `Bearer ${token}`)
      .attach('file', Buffer.alloc(0), { filename: 'empty.png', contentType: 'image/png' })
      .expect(400);
  });
});
