import { Router, type Request, type Response } from 'express';
import { moderationSchemas } from '@safecheck/shared';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth, requireFreshRole, requireRole } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rate-limit.js';
import { body, params, query, validate } from '../../middleware/validate.js';
import { auditContextFromRequest } from '../../services/audit.service.js';
import * as moderationService from './moderation.service.js';

/**
 * Moderation routes. Moderator and admin only, top to bottom.
 *
 * The route table mirrors the service's central separation: issuing a decision
 * and clearing it for publication are different endpoints, different verbs, and
 * different authorisation checks. They are never reachable by one call, because
 * deciding and publishing must never be the same click.
 *
 * `requireFreshRole` is used on publication rather than the cheaper `requireRole`.
 * A signed JWT carries whatever role was held when it was minted, so a demoted
 * moderator could otherwise publish a record about a person for up to the
 * access-token TTL. That window is acceptable for reading a queue; it is not
 * acceptable for making an allegation searchable.
 */

const idParam = z.object({ id: z.string() });

export const moderationRouter = Router();

moderationRouter.use(requireAuth, requireRole('moderator'));

/* -------------------------------------------------------------------- queue */

moderationRouter.get(
  '/queue',
  validate({ query: moderationSchemas.listQueueQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const cases = await moderationService.listQueue({
      query: query<moderationSchemas.ListQueueQuery>(req),
      actorId: req.auth!.userId,
    });
    res.status(200).json({ cases });
  }),
);

/* --------------------------------------------------------------- case detail */

moderationRouter.get(
  '/cases/:id',
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const kase = await moderationService.loadCase(params<{ id: string }>(req).id);
    res.status(200).json({ case: await moderationService.toCaseDetail(kase) });
  }),
);

/* ------------------------------------------------------------------- assign */

moderationRouter.post(
  '/cases/:id/assign',
  writeLimiter,
  validate({ params: idParam, body: moderationSchemas.assignCaseInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const kase = await moderationService.loadCase(params<{ id: string }>(req).id);
    const updated = await moderationService.assignCase({
      kase,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      moderatorId: body<moderationSchemas.AssignCaseInput>(req).moderatorId,
      context: auditContextFromRequest(req),
    });
    res.status(200).json({ case: await moderationService.toCaseDetail(updated) });
  }),
);

/* -------------------------------------------------------------------- state */

moderationRouter.patch(
  '/cases/:id/state',
  writeLimiter,
  validate({ params: idParam, body: moderationSchemas.setCaseStateInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const kase = await moderationService.loadCase(params<{ id: string }>(req).id);
    const updated = await moderationService.setCaseState({
      kase,
      to: body<moderationSchemas.SetCaseStateInput>(req).state,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      context: auditContextFromRequest(req),
    });
    res.status(200).json({ case: await moderationService.toCaseDetail(updated) });
  }),
);

/* ----------------------------------------------------------------- priority */

moderationRouter.patch(
  '/cases/:id/priority',
  writeLimiter,
  validate({ params: idParam, body: moderationSchemas.setCasePriorityInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const kase = await moderationService.loadCase(params<{ id: string }>(req).id);
    const updated = await moderationService.setCasePriority({
      kase,
      priority: body<moderationSchemas.SetCasePriorityInput>(req).priority,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      context: auditContextFromRequest(req),
    });
    res.status(200).json({ case: await moderationService.toCaseDetail(updated) });
  }),
);

/* -------------------------------------------------------------------- notes */

moderationRouter.post(
  '/cases/:id/notes',
  writeLimiter,
  validate({ params: idParam, body: moderationSchemas.addCaseNoteInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const kase = await moderationService.loadCase(params<{ id: string }>(req).id);
    const updated = await moderationService.addCaseNote({
      kase,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      input: body<moderationSchemas.AddCaseNoteInput>(req),
      context: auditContextFromRequest(req),
    });
    res.status(201).json({ case: await moderationService.toCaseDetail(updated) });
  }),
);

/* ----------------------------------------------------------------- decision */

moderationRouter.post(
  '/cases/:id/decision',
  writeLimiter,
  // Fresh role: issuing a decision is the act that starts the appeal clock and
  // tells a person they have been found against. It outlives the token.
  requireFreshRole('moderator'),
  validate({ params: idParam, body: moderationSchemas.issueDecisionInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const kase = await moderationService.loadCase(params<{ id: string }>(req).id);
    const decision = await moderationService.issueDecision({
      kase,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      input: body<moderationSchemas.IssueDecisionInput>(req),
      context: auditContextFromRequest(req),
    });
    res.status(201).json({
      decision: {
        id: decision._id.toString(),
        outcome: decision.outcome,
        rationale: decision.rationale,
        // Always false on issue. Surfaced so the UI states it rather than
        // leaving the moderator to assume either way.
        publishable: decision.publishable,
        appealWindowEndsAt: decision.appealWindowEndsAt.toISOString(),
        issuedAt: decision.issuedAt.toISOString(),
      },
    });
  }),
);

/* -------------------------------------------------------------- publication */

moderationRouter.patch(
  '/decisions/:id/publishable',
  writeLimiter,
  requireFreshRole('moderator'),
  validate({ params: idParam, body: moderationSchemas.setDecisionPublishableInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const decision = await moderationService.setDecisionPublishable({
      decisionId: params<{ id: string }>(req).id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      input: body<moderationSchemas.SetDecisionPublishableInput>(req),
      context: auditContextFromRequest(req),
    });

    // Publishable is not the same as disclosed, and a moderator who is not told
    // the difference will assume it is. The gate's own verdict is returned
    // alongside the flag so the UI can show what is still outstanding.
    res.status(200).json({
      decision: {
        id: decision._id.toString(),
        publishable: decision.publishable,
        publishableSetBy: decision.publishableSetBy?.toString() ?? null,
      },
      disclosure: await moderationService.explainDisclosure(decision._id.toString()),
    });
  }),
);

moderationRouter.get(
  '/decisions/:id/disclosure',
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const disclosure = await moderationService.explainDisclosure(params<{ id: string }>(req).id);
    res.status(200).json({ disclosure });
  }),
);
