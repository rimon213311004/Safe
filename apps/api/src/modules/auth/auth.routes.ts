import { Router, type Request, type Response } from 'express';
import { authSchemas } from '@safecheck/shared';
import { env, isProd } from '../../config/env.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { authLimiter, otpLimiter } from '../../middleware/rate-limit.js';
import { body, validate } from '../../middleware/validate.js';
import { auditContextFromRequest, recordAudit } from '../../services/audit.service.js';
import {
  revokeFamily,
  rotateRefreshToken,
  signAccessToken,
} from '../../services/token.service.js';
import { User } from '../../models/index.js';
import { unauthenticated } from '../../lib/errors.js';
import * as authService from './auth.service.js';

/**
 * Auth routes.
 *
 * Token placement: the access token goes in the response body (the client keeps
 * it in memory only), and the refresh token goes in an httpOnly, SameSite=Strict
 * cookie scoped to the refresh path. That split means XSS cannot read the
 * long-lived credential, and CSRF cannot use it against any endpoint other than
 * /auth/refresh — which itself only ever returns a new access token.
 */

const REFRESH_COOKIE = 'sc_rt';
const REFRESH_PATH = '/api/auth';

function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: REFRESH_PATH,
    expires: expiresAt,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
}

function authPayload(result: authService.AuthSuccess) {
  return {
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
    user: result.user,
  };
}

export const authRouter = Router();

/* -------------------------------------------------------------- register */

authRouter.post(
  '/register',
  authLimiter,
  validate({ body: authSchemas.registerInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const input = body<authSchemas.RegisterInput>(req);
    await authService.registerUser({
      email: input.email,
      password: input.password,
      name: input.name,
      context: auditContextFromRequest(req),
    });
    // Always the same response whether or not the address was already taken.
    res.status(202).json({
      status: 'verification_sent',
      message: 'Check your email for a 6-digit confirmation code.',
      email: input.email,
    });
  }),
);

authRouter.post(
  '/verify-email',
  otpLimiter,
  validate({ body: authSchemas.verifyEmailInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const input = body<authSchemas.VerifyEmailInput>(req);
    const result = await authService.verifyEmail({
      email: input.email,
      code: input.code,
      userAgent: req.get('user-agent') ?? '',
      ip: req.ip,
      context: auditContextFromRequest(req),
    });
    setRefreshCookie(res, result.refresh.token, result.refresh.expiresAt);
    res.status(200).json(authPayload(result));
  }),
);

authRouter.post(
  '/resend-otp',
  otpLimiter,
  validate({ body: authSchemas.resendOtpInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const input = body<authSchemas.ResendOtpInput>(req);
    // Only send if the account exists, but respond identically either way.
    const exists = await User.exists({ email: input.email });
    if (exists) {
      await authService.issueEmailOtp({ email: input.email, purpose: input.purpose });
    }
    res.status(202).json({ status: 'verification_sent' });
  }),
);

/* ----------------------------------------------------------------- login */

authRouter.post(
  '/login',
  authLimiter,
  validate({ body: authSchemas.loginInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const input = body<authSchemas.LoginInput>(req);
    const result = await authService.login({
      email: input.email,
      password: input.password,
      userAgent: req.get('user-agent') ?? '',
      ip: req.ip,
      context: auditContextFromRequest(req),
    });
    setRefreshCookie(res, result.refresh.token, result.refresh.expiresAt);
    res.status(200).json(authPayload(result));
  }),
);

/* --------------------------------------------------------------- refresh */

authRouter.post(
  '/refresh',
  asyncHandler(async (req: Request, res: Response) => {
    const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!presented) throw unauthenticated('Please sign in again.');

    const rotated = await rotateRefreshToken(presented);
    const user = await User.findById(rotated.userId);
    if (!user) throw unauthenticated('Please sign in again.');

    const access = await signAccessToken({
      userId: rotated.userId,
      role: user.role,
      sessionFamily: rotated.refresh.family,
    });

    setRefreshCookie(res, rotated.refresh.token, rotated.refresh.expiresAt);
    res.status(200).json({
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      user: authService.toAuthUser(user),
    });
  }),
);

/* ---------------------------------------------------------------- logout */

authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await revokeFamily(req.auth!.sessionFamily, 'user_logout');
    await recordAudit('auth.logout', {
      context: auditContextFromRequest(req),
      targetType: 'User',
      targetId: req.auth!.userId,
    });
    clearRefreshCookie(res);
    res.status(204).send();
  }),
);

/* -------------------------------------------------------------------- me */

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await User.findById(req.auth!.userId);
    if (!user) throw unauthenticated();
    res.status(200).json({ user: authService.toAuthUser(user) });
  }),
);

authRouter.post(
  '/change-password',
  requireAuth,
  authLimiter,
  validate({ body: authSchemas.changePasswordInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const input = body<authSchemas.ChangePasswordInput>(req);
    await authService.changePassword({
      userId: req.auth!.userId,
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
      context: auditContextFromRequest(req),
    });
    clearRefreshCookie(res);
    res.status(204).send();
  }),
);

export { REFRESH_COOKIE, env as authRoutesEnv };
