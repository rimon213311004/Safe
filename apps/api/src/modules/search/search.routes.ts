import { Router, type Request, type Response } from 'express';
import { searchSchemas } from '@safecheck/shared';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { searchLimiter } from '../../middleware/rate-limit.js';
import { body, validate } from '../../middleware/validate.js';
import { auditContextFromRequest } from '../../services/audit.service.js';
import * as searchService from './search.service.js';

/**
 * Search routes.
 *
 * Two deliberate choices:
 *
 *  • POST, not GET. The request body carries an identifier for a person who is
 *    probably not the caller. A GET would put it in the URL, and from there into
 *    access logs, proxy logs, browser history, and any Referer header.
 *
 *  • Authenticated. Disclosure about a third party should be attributable to
 *    someone — `search.performed` records the actor, which is only meaningful if
 *    there is one. It also gives the rate limiter an account to bind to rather
 *    than a shared IP.
 */

export const searchRouter = Router();

searchRouter.use(requireAuth);

searchRouter.post(
  '/',
  searchLimiter,
  validate({ body: searchSchemas.searchInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await searchService.search({
      input: body<searchSchemas.SearchInput>(req),
      context: auditContextFromRequest(req),
    });
    // `no-store` keeps a result about a third party out of shared caches.
    res.setHeader('Cache-Control', 'no-store, private');
    res.status(200).json(result);
  }),
);
