import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import './setup.js';
import { createApp } from '../app.js';
import { capturedMail } from '../services/messaging.service.js';
import { Session, User } from '../models/index.js';

/**
 * Auth integration tests. These drive the real Express app against a real
 * (in-memory) MongoDB — no mocks — so middleware, cookies, and Mongoose
 * behaviour are all exercised as they would be in production.
 */

const app = createApp();

const CREDENTIALS = {
  email: 'reporter@example.com',
  password: 'Correct-Horse-9',
  name: 'Test Reporter',
};

/** Pull the 6-digit code out of the captured email. */
function latestOtp(): string {
  const message = capturedMail.sent.at(-1);
  if (!message) throw new Error('no email was sent');
  const match = /\b(\d{6})\b/.exec(message.body);
  if (!match) throw new Error(`no code in email body: ${message.body}`);
  return match[1]!;
}

/** Register + verify, returning the access token and refresh cookie. */
async function registerAndVerify(overrides: Partial<typeof CREDENTIALS> = {}) {
  const creds = { ...CREDENTIALS, ...overrides };
  await request(app).post('/api/auth/register').send(creds).expect(202);
  const res = await request(app)
    .post('/api/auth/verify-email')
    .send({ email: creds.email, code: latestOtp() })
    .expect(200);
  return {
    creds,
    accessToken: res.body.accessToken as string,
    cookie: res.headers['set-cookie'] as unknown as string[],
    user: res.body.user,
  };
}

beforeEach(() => {
  capturedMail.sent.length = 0;
});

describe('registration and email verification', () => {
  it('registers, emails a code, and issues tokens once verified', async () => {
    const { accessToken, user, cookie } = await registerAndVerify();

    expect(accessToken).toBeTypeOf('string');
    expect(user.email).toBe(CREDENTIALS.email);
    expect(user.emailVerified).toBe(true);
    expect(user.role).toBe('user');
    // Refresh token must be httpOnly and path-scoped, never readable by JS.
    expect(cookie.join(';')).toMatch(/sc_rt=/);
    expect(cookie.join(';')).toMatch(/HttpOnly/i);
    expect(cookie.join(';')).toMatch(/Path=\/api\/auth/i);
  });

  it('never returns the password hash to the client', async () => {
    const { user } = await registerAndVerify();
    expect(JSON.stringify(user)).not.toMatch(/passwordHash|argon2/i);
  });

  it('rejects a wrong code and counts the attempt', async () => {
    await request(app).post('/api/auth/register').send(CREDENTIALS).expect(202);
    await request(app)
      .post('/api/auth/verify-email')
      .send({ email: CREDENTIALS.email, code: '000000' })
      .expect(412);
  });

  it('does not reveal whether an email is already registered', async () => {
    await registerAndVerify();
    // Re-registering a verified address must look identical to a fresh signup.
    const res = await request(app).post('/api/auth/register').send(CREDENTIALS).expect(202);
    expect(res.body.status).toBe('verification_sent');
    // ...and must not have created a second account.
    expect(await User.countDocuments({ email: CREDENTIALS.email })).toBe(1);
  });

  it('rejects a weak password with field-level detail', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, password: 'short' })
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.password).toBeDefined();
  });
});

describe('login', () => {
  it('signs in a verified user', async () => {
    await registerAndVerify();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password })
      .expect(200);
    expect(res.body.accessToken).toBeTypeOf('string');
  });

  it('gives the same error for a bad password and an unknown address', async () => {
    await registerAndVerify();

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: CREDENTIALS.email, password: 'Wrong-Password-1' })
      .expect(401);

    const unknownUser = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'Wrong-Password-1' })
      .expect(401);

    // Identical wording — otherwise this endpoint enumerates accounts.
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
    expect(wrongPassword.body.error.code).toBe(unknownUser.body.error.code);
  });

  it('blocks an unverified account and re-sends a code', async () => {
    await request(app).post('/api/auth/register').send(CREDENTIALS).expect(202);
    capturedMail.sent.length = 0;

    await request(app)
      .post('/api/auth/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password })
      .expect(412);

    expect(capturedMail.sent).toHaveLength(1);
  });
});

describe('protected routes', () => {
  it('rejects a request with no token', async () => {
    await request(app).get('/api/auth/me').expect(401);
  });

  it('rejects a garbage token', async () => {
    await request(app)
      .get('/api/auth/me')
      .set('authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('returns the current user with a valid token', async () => {
    const { accessToken } = await registerAndVerify();
    const res = await request(app)
      .get('/api/auth/me')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.user.email).toBe(CREDENTIALS.email);
  });
});

describe('refresh token rotation', () => {
  it('rotates the token and keeps the session usable', async () => {
    const { cookie } = await registerAndVerify();

    const first = await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(200);
    expect(first.body.accessToken).toBeTypeOf('string');

    const rotatedCookie = first.headers['set-cookie'] as unknown as string[];
    expect(rotatedCookie.join(';')).not.toBe(cookie.join(';'));

    // The new token works.
    await request(app).post('/api/auth/refresh').set('Cookie', rotatedCookie).expect(200);
  });

  it('detects reuse of an already-rotated token and revokes the whole family', async () => {
    const { cookie, accessToken } = await registerAndVerify();

    // Legitimate rotation.
    const rotated = await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(200);
    const rotatedCookie = rotated.headers['set-cookie'] as unknown as string[];

    // An attacker replays the ORIGINAL token. This must fail...
    await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(401);

    // ...and must also kill the legitimate successor, because we cannot tell
    // which party is the thief.
    await request(app).post('/api/auth/refresh').set('Cookie', rotatedCookie).expect(401);

    // The access token is dead too: requireAuth checks the family is live.
    await request(app).get('/api/auth/me').set('authorization', `Bearer ${accessToken}`).expect(401);

    const sessions = await Session.find({}).lean();
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    expect(sessions.some((s) => s.revokedReason === 'refresh_token_reuse_detected')).toBe(true);
  });

  it('rejects a refresh with no cookie', async () => {
    await request(app).post('/api/auth/refresh').expect(401);
  });
});

describe('logout', () => {
  it('revokes the session so the access token stops working', async () => {
    const { accessToken, cookie } = await registerAndVerify();

    await request(app)
      .post('/api/auth/logout')
      .set('authorization', `Bearer ${accessToken}`)
      .set('Cookie', cookie)
      .expect(204);

    // Immediate revocation — not "valid until the JWT expires".
    await request(app).get('/api/auth/me').set('authorization', `Bearer ${accessToken}`).expect(401);
    await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(401);
  });
});

describe('change password', () => {
  it('changes the password and signs every device out', async () => {
    const { accessToken, cookie } = await registerAndVerify();

    await request(app)
      .post('/api/auth/change-password')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: CREDENTIALS.password, newPassword: 'Brand-New-Pass-7' })
      .expect(204);

    // Old sessions are gone.
    await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(401);

    // Old password no longer works; new one does.
    await request(app)
      .post('/api/auth/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password })
      .expect(401);
    await request(app)
      .post('/api/auth/login')
      .send({ email: CREDENTIALS.email, password: 'Brand-New-Pass-7' })
      .expect(200);
  });

  it('rejects a wrong current password', async () => {
    const { accessToken } = await registerAndVerify();
    await request(app)
      .post('/api/auth/change-password')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'Not-The-Password-1', newPassword: 'Brand-New-Pass-7' })
      .expect(401);
  });
});
