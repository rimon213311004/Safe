import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { params, validate } from '../../middleware/validate.js';
import { auditContextFromRequest } from '../../services/audit.service.js';
import * as evidenceService from './evidence.service.js';

/**
 * Evidence routes.
 *
 * There is exactly one way to read an evidence file, and it runs through
 * `readEvidence`, which checks party membership, checks scan status, and writes
 * an audit row before any byte is sent. No static path, no redirect to a storage
 * URL — the bytes are proxied so the platform stays the sole gatekeeper.
 */

const idParam = z.object({ id: z.string() });

export const evidenceRouter = Router();

evidenceRouter.use(requireAuth);

evidenceRouter.get(
  '/:id/content',
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<{ id: string }>(req);

    const file = await evidenceService.readEvidence({
      evidenceId: id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      context: auditContextFromRequest(req),
    });

    // `attachment` prevents the browser from rendering the file in-origin, which
    // would turn any stored HTML/SVG into a stored-XSS vector. `nosniff` stops
    // content-type guessing. `no-store` keeps evidence out of disk caches and
    // shared proxies.
    res.setHeader('Content-Type', file.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
    res.status(200).send(file.buffer);
  }),
);
