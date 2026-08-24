import { z } from 'zod';
import { displayName, email, otpCode, password } from './common.js';

/* ------------------------------------------------------------- registration */

export const registerInput = z.object({
  email,
  password,
  name: displayName,
});
export type RegisterInput = z.infer<typeof registerInput>;

/** Sent after registration; the user must verify their email with an OTP. */
export const verifyEmailInput = z.object({
  email,
  code: otpCode,
});
export type VerifyEmailInput = z.infer<typeof verifyEmailInput>;

export const resendOtpInput = z.object({
  email,
  purpose: z.enum(['verify_email', 'login']).default('verify_email'),
});
export type ResendOtpInput = z.infer<typeof resendOtpInput>;

/* -------------------------------------------------------------------- login */

export const loginInput = z.object({
  email,
  password: z.string().min(1, 'Enter your password'),
});
export type LoginInput = z.infer<typeof loginInput>;

/**
 * Login can require a second step (email OTP) when 2FA is enabled or the device
 * is unrecognised. The API responds with either tokens or a `challenge`.
 */
export const loginChallengeInput = z.object({
  challengeId: z.string().min(1),
  code: otpCode,
});
export type LoginChallengeInput = z.infer<typeof loginChallengeInput>;

/* ---------------------------------------------------------------- passwords */

export const changePasswordInput = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: password,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    error: 'Choose a password different from your current one',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;

/**
 * Step one of a forgotten password: ask for a reset code by email.
 *
 * Deliberately takes nothing but the address. Anything else — a security
 * question, the account's name — would let a stranger probe the account before
 * proving they can read its mail.
 */
export const forgotPasswordInput = z.object({ email });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordInput>;

/** Step two: the code from that email, plus the replacement password. */
export const resetPasswordInput = z.object({
  email,
  code: otpCode,
  newPassword: password,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordInput>;

/* ------------------------------------------------------------ public shapes */

/** The authenticated user as returned to the client. Never includes secrets. */
export const authUser = z.object({
  id: z.string(),
  email: z.email(),
  name: z.string(),
  role: z.enum(['user', 'moderator', 'admin']),
  emailVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type AuthUser = z.infer<typeof authUser>;

/** Successful auth: access token in the body, refresh token set as a cookie. */
export const authTokens = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
  user: authUser,
});
export type AuthTokens = z.infer<typeof authTokens>;

/** Second-factor challenge response (no tokens issued yet). */
export const authChallenge = z.object({
  challengeId: z.string(),
  method: z.literal('email_otp'),
  hint: z.string(),
});
export type AuthChallenge = z.infer<typeof authChallenge>;
