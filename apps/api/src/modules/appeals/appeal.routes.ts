import { Router, type Request, type Response } from 'express';
import { appealSchemas } from '@safecheck/shared';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth, requireFreshRole, requireRole } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rate-limit.js';
import { body, params, query, validate } from '../../middleware/validate.js';
import { auditContextFromRequest } from '../../services/audit.service.js';
import * as appealService from './appeal.service.js';

/**
 * Appeal routes.
 *
 * Filing lives on the report router (`POST /api/reports/:id/appeals`) because an
 * appeal is always against a specific report's decision — the same nesting the
 * evidence module uses. Everything that acts on an existing appeal lives here.
 *
 * The independence rule — a moderator may not review an appeal against their own
 * decision — is enforced in the service, not here, so that claiming and resolving
 * cannot drift apart. These routes deliberately add no authorisation of their own
 * beyond the role gate.
 */

const idParam = z.object({ id: z.string() });
const pendingQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const appealRouter = Router();

appealRouter.use(requireAuth);

/* -------------------------------------------------------- moderator queue */

/**
 * Registered before `/:id` so the literal path wins — Express matches in
 * declaration order and `/:id` would otherwise capture "pending".
 */
appealRouter.get(
  '/pending',
  requireRole('moderator'),
  validate({ query: pendingQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const appeals = await appealService.listPendingAppeals(
      query<z.infer<typeof pendingQuery>>(req).limit,
    );
    res.status(200).json({ appeals });
  }),
);

/* ------------------------------------------------------------------ detail */

appealRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const appeal = await appealService.loadAppealForActor({
      appealId: params<{ id: string }>(req).id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
    });
    res.status(200).json({ appeal: appealService.toAppealDetail(appeal) });
  }),
);

/* ---------------------------------------------------------------- withdraw */

appealRouter.post(
  '/:id/withdraw',
  writeLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const appeal = await appealService.loadAppealForActor({
      appealId: params<{ id: string }>(req).id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
    });
    const withdrawn = await appealService.withdrawAppeal({
      appeal,
      actorId: req.auth!.userId,
      context: auditContextFromRequest(req),
    });
    res.status(200).json({ appeal: appealService.toAppealDetail(withdrawn) });
  }),
);

/* ------------------------------------------------------------------- claim */

appealRouter.post(
  '/:id/claim',
  writeLimiter,
  requireRole('moderator'),
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const appeal = await appealService.loadAppealForActor({
      appealId: params<{ id: string }>(req).id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
    });
    const claimed = await appealService.claimAppeal({
      appeal,
      actorId: req.auth!.userId,
      context: auditContextFromRequest(req),
    });
    res.status(200).json({ appeal: appealService.toAppealDetail(claimed) });
  }),
);

/* ----------------------------------------------------------------- resolve */

appealRouter.post(
  '/:id/resolve',
  writeLimiter,
  // Fresh role: granting an appeal can vacate a decision and reopen a case. A
  // moderator demoted since their token was minted must not still be able to.
  requireFreshRole('moderator'),
  validate({ params: idParam, body: appealSchemas.resolveAppealInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const appeal = await appealService.loadAppealForActor({
      appealId: params<{ id: string }>(req).id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
    });
    const resolved = await appealService.resolveAppeal({
      appeal,
      actorId: req.auth!.userId,
      input: body<appealSchemas.ResolveAppealInput>(req),
      context: auditContextFromRequest(req),
    });
    res.status(200).json({ appeal: appealService.toAppealDetail(resolved) });
  }),
);
