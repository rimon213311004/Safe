import type { Role } from '@safecheck/shared';

/**
 * Express request augmentation.
 *
 * `req.auth` is populated by requireAuth and is the only sanctioned way a
 * handler learns who is calling — handlers must never parse the Authorization
 * header themselves.
 *
 * `req.validated` is populated by the validate() middleware. It is typed as
 * unknown on purpose: handlers narrow it with the same Zod-inferred type the
 * route declared, which keeps the schema as the single source of truth instead
 * of letting a loose `any` drift away from it.
 */
declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        role: Role;
        sessionFamily: string;
      };
      validated?: {
        body: unknown;
        query: unknown;
        params: unknown;
      };
      /** Correlation id attached by the requestId middleware. */
      requestId?: string;
    }
  }
}

export {};
