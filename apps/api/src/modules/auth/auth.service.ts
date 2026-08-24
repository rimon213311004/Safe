import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { AuthUser } from '@safecheck/shared';
import { env } from '../../config/env.js';
import { generateOtp, hashToken, safeEqual } from '../../lib/crypto.js';
import {
  conflict,
  forbidden,
  invalidCredentials,
  preconditionFailed,
  unauthenticated,
} from '../../lib/errors.js';
import { Otp, User, type UserDoc } from '../../models/index.js';
import { mailer } from '../../services/messaging.service.js';
import { recordAudit, type AuditContext } from '../../services/audit.service.js';
import {
  issueRefreshToken,
  revokeAllSessions,
  signAccessToken,
  type IssuedRefreshToken,
} from '../../services/token.service.js';

/**
 * Auth service.
 *
 * argon2id parameters below follow OWASP's recommended baseline. They are set
 * explicitly rather than left to library defaults so a dependency bump can't
 * silently weaken password hashing.
 */
const ARGON_OPTIONS = {
  // argon2id
  algorithm: 2 as const,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

const OTP_TTL_MS = 10 * 60_000;

/**
 * A real argon2id hash of a throwaway value, computed once at boot.
 *
 * When login is attempted for an address that doesn't exist we verify the
 * supplied password against this instead of returning immediately. Without it,
 * "no such user" would answer in microseconds while "wrong password" takes ~50ms
 * of deliberate argon2 work — a timing difference big enough to enumerate which
 * email addresses are registered. Hashing a constant is cheap insurance.
 */
const dummyHashPromise: Promise<string> = argonHash(
  'safecheck-timing-equaliser-not-a-real-password',
  ARGON_OPTIONS,
);

export function toAuthUser(user: UserDoc): AuthUser {
  return {
    id: String(user._id),
    email: user.email,
    name: user.name,
    role: user.role,
    emailVerified: user.emailVerified,
    twoFactorEnabled: user.twoFactorEnabled,
    createdAt: user.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ signup */

export async function registerUser(params: {
  email: string;
  password: string;
  name: string;
  context: AuditContext;
}): Promise<{ email: string }> {
  const existing = await User.findOne({ email: params.email }).select('_id emailVerified').lean();
  if (existing) {
    // An unverified account can be re-registered (the person may have lost the
    // code). A verified one cannot — but we must not confirm that the address is
    // taken, so we send the same response and simply don't create anything.
    if (existing.emailVerified) {
      await issueEmailOtp({ email: params.email, purpose: 'verify_email', silent: true });
      return { email: params.email };
    }
    await User.deleteOne({ _id: existing._id });
  }

  const passwordHash = await argonHash(params.password, ARGON_OPTIONS);
  const user = await User.create({
    email: params.email,
    name: params.name,
    passwordHash,
    emailVerified: false,
  });

  await issueEmailOtp({ email: params.email, purpose: 'verify_email' });
  await recordAudit('account.registered', {
    context: params.context,
    targetType: 'User',
    targetId: String(user._id),
  });

  return { email: params.email };
}

/* --------------------------------------------------------------------- otp */

export async function issueEmailOtp(params: {
  email: string;
  purpose: 'verify_email' | 'login' | 'password_reset';
  silent?: boolean;
}): Promise<void> {
  // Invalidate any outstanding codes for this purpose so only the newest works.
  await Otp.updateMany(
    { email: params.email, purpose: params.purpose, consumedAt: null },
    { $set: { consumedAt: new Date() } },
  );

  const code = generateOtp();
  await Otp.create({
    email: params.email,
    purpose: params.purpose,
    codeHash: hashToken(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });

  if (params.silent) return;

  const subjectLine =
    params.purpose === 'verify_email' ? 'Confirm your SafeCheck email' : 'Your SafeCheck sign-in code';

  await mailer.send({
    to: params.email,
    subject: subjectLine,
    body:
      `Your SafeCheck verification code is:\n\n    ${code}\n\n` +
      `It expires in ${OTP_TTL_MS / 60_000} minutes. If you didn't request it, ignore this message.`,
  });
}

/**
 * Consume an OTP. Attempts are counted on the stored document so a 6-digit code
 * can't be brute-forced inside its 10-minute life, even across IPs.
 */
async function consumeOtp(params: {
  email: string;
  code: string;
  purpose: 'verify_email' | 'login' | 'password_reset';
}): Promise<void> {
  const otp = await Otp.findOne({
    email: params.email,
    purpose: params.purpose,
    consumedAt: null,
  }).sort({ createdAt: -1 });

  if (!otp) throw preconditionFailed('That code is no longer valid. Request a new one.');

  if (otp.expiresAt.getTime() <= Date.now()) {
    throw preconditionFailed('That code has expired. Request a new one.');
  }

  if (otp.attempts >= otp.maxAttempts) {
    otp.consumedAt = new Date();
    await otp.save();
    throw preconditionFailed('Too many incorrect attempts. Request a new code.');
  }

  if (!safeEqual(otp.codeHash, hashToken(params.code))) {
    otp.attempts += 1;
    await otp.save();
    throw preconditionFailed('That code is incorrect.');
  }

  otp.consumedAt = new Date();
  await otp.save();
}

export async function verifyEmail(params: {
  email: string;
  code: string;
  userAgent?: string;
  ip?: string;
  context: AuditContext;
}): Promise<AuthSuccess> {
  await consumeOtp({ email: params.email, code: params.code, purpose: 'verify_email' });

  const user = await User.findOne({ email: params.email });
  if (!user) throw preconditionFailed('That code is no longer valid. Request a new one.');

  if (!user.emailVerified) {
    user.emailVerified = true;
    await user.save();
  }

  return establishSession({ user, userAgent: params.userAgent, ip: params.ip, context: params.context });
}

/* ------------------------------------------------------------------- login */

export interface AuthSuccess {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refresh: IssuedRefreshToken;
  user: AuthUser;
}

const MAX_FAILED_LOGINS = 8;
const LOCK_MS = 15 * 60_000;

export async function login(params: {
  email: string;
  password: string;
  userAgent?: string;
  ip?: string;
  context: AuditContext;
}): Promise<AuthSuccess> {
  const user = await User.findOne({ email: params.email }).select('+passwordHash');

  if (!user) {
    // Equalise response timing against the real-user path so this endpoint can't
    // be used to enumerate registered addresses.
    await argonVerify(await dummyHashPromise, params.password).catch(() => false);
    await recordAudit('auth.login_failed', { context: params.context, meta: { reason: 'no_such_user' } });
    throw invalidCredentials();
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw forbidden('Too many failed attempts. Try again in a little while.');
  }

  const ok = await argonVerify(user.passwordHash, params.password).catch(() => false);
  if (!ok) {
    user.failedLoginCount += 1;
    if (user.failedLoginCount >= MAX_FAILED_LOGINS) {
      user.lockedUntil = new Date(Date.now() + LOCK_MS);
      user.failedLoginCount = 0;
    }
    await user.save();
    await recordAudit('auth.login_failed', {
      context: params.context,
      targetType: 'User',
      targetId: String(user._id),
      meta: { reason: 'bad_password' },
    });
    throw invalidCredentials();
  }

  if (!user.emailVerified) {
    await issueEmailOtp({ email: user.email, purpose: 'verify_email' });
    throw preconditionFailed('Confirm your email first — we have sent you a new code.');
  }

  if (user.failedLoginCount !== 0 || user.lockedUntil) {
    user.failedLoginCount = 0;
    user.lockedUntil = null;
    await user.save();
  }

  return establishSession({ user, userAgent: params.userAgent, ip: params.ip, context: params.context });
}

async function establishSession(params: {
  user: UserDoc;
  userAgent?: string;
  ip?: string;
  context: AuditContext;
}): Promise<AuthSuccess> {
  const refresh = await issueRefreshToken({
    userId: String(params.user._id),
    userAgent: params.userAgent,
    ip: params.ip,
  });
  const access = await signAccessToken({
    userId: String(params.user._id),
    role: params.user.role,
    sessionFamily: refresh.family,
  });

  await recordAudit('auth.login', {
    context: { ...params.context, actorId: String(params.user._id), actorRole: params.user.role },
    targetType: 'User',
    targetId: String(params.user._id),
  });

  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refresh,
    user: toAuthUser(params.user),
  };
}

/* ---------------------------------------------------------------- password */

export async function changePassword(params: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  context: AuditContext;
}): Promise<void> {
  const user = await User.findById(params.userId).select('+passwordHash');
  if (!user) throw unauthenticated();

  const ok = await argonVerify(user.passwordHash, params.currentPassword).catch(() => false);
  if (!ok) throw invalidCredentials();

  user.passwordHash = await argonHash(params.newPassword, ARGON_OPTIONS);
  await user.save();

  // Changing a password invalidates every existing session, everywhere. If the
  // change was prompted by suspected compromise, leaving other devices signed in
  // would defeat the point.
  await revokeAllSessions(params.userId, 'password_changed');

  await recordAudit('auth.password_changed', {
    context: params.context,
    targetType: 'User',
    targetId: params.userId,
  });
}

export async function ensureEmailAvailable(email: string): Promise<void> {
  const exists = await User.exists({ email });
  if (exists) throw conflict('That email is already registered.');
}

export { env as authEnv };
