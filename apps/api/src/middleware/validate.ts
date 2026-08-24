import type { NextFunction, Request, Response } from 'express';
import { z, type ZodType } from 'zod';
import { AppError } from '../lib/errors.js';

/**
 * Validation middleware. Handlers should never see unvalidated input — a route
 * declares a schema for body/query/params and receives typed, sanitised values.
 *
 * On failure we return 422 with field-level details straight from Zod, so the
 * client's react-hook-form resolver (using the SAME schema) and the server agree
 * on error shape.
 */

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const out: { body: unknown; query: unknown; params: unknown } = {
      body: undefined,
      query: undefined,
      params: undefined,
    };

    for (const key of ['body', 'query', 'params'] as const) {
      const schema = schemas[key];
      if (!schema) continue;
      const parsed = schema.safeParse(req[key]);
      if (!parsed.success) {
        next(
          new AppError('VALIDATION_FAILED', 'Some fields need your attention', {
            details: z.flattenError(parsed.error).fieldErrors,
          }),
        );
        return;
      }
      out[key] = parsed.data;
    }

    req.validated = out;
    next();
  };
}

/**
 * Typed accessors for validated input. The cast is safe because validate() has
 * already parsed with the route's schema; naming the type at the call site keeps
 * handlers readable and tied to the shared contract.
 */
export function body<T>(req: Request): T {
  return req.validated!.body as T;
}

export function query<T>(req: Request): T {
  return req.validated!.query as T;
}

export function params<T>(req: Request): T {
  return req.validated!.params as T;
}
