'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { z, type ZodType } from 'zod';
import { ApiError } from './api';

/**
 * The three things every screen in this app does: validate a form, run a
 * mutation, load a resource. Kept deliberately small — no form library, because
 * the validation contract already exists in `@safecheck/shared` and the only
 * thing missing was a place to put the result.
 */

/** `z.flattenError().fieldErrors` — the exact shape the API's 422 sends back. */
export type FieldErrors = Record<string, string[]>;

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; fieldErrors: FieldErrors; formErrors: string[] };

/**
 * Validate input with a shared schema before it leaves the browser.
 *
 * This is not a substitute for the server's check — the server validates with
 * this same schema and is the only authority. It exists because some rules live
 * at the object root rather than on a field: `subjectIdentifierInput` requires an
 * email *or* a phone, and `searchInput` requires exactly one. Those land in
 * `formErrors`, and the API's error envelope forwards only `fieldErrors` — so
 * checking here is what turns "Some fields need your attention" into a sentence
 * that says which rule was broken.
 */
export function validate<S extends ZodType>(schema: S, input: unknown): ValidationResult<z.output<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  const flat = z.flattenError(parsed.error);
  return {
    ok: false,
    fieldErrors: flat.fieldErrors as FieldErrors,
    formErrors: flat.formErrors,
  };
}

/* ------------------------------------------------------------------ mutations */

export interface Action {
  pending: boolean;
  /** A single sentence safe to show the user, or null. */
  error: string | null;
  fieldErrors: FieldErrors;
  /** Runs `fn`, returning `undefined` if it failed so callers can branch on it. */
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  fail: (message: string, fieldErrors?: FieldErrors) => void;
  reset: () => void;
}

export function useAction(): Action {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const reset = useCallback(() => {
    setError(null);
    setFieldErrors({});
  }, []);

  const fail = useCallback((message: string, fields: FieldErrors = {}) => {
    setError(message);
    setFieldErrors(fields);
  }, []);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      return await fn();
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.message);
        setFieldErrors(cause.fieldErrors);
      } else {
        // Anything that is not an ApiError never reached the API, so there is no
        // server message to relay and no detail worth showing.
        setError('Something went wrong. Please try again.');
      }
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);

  return { pending, error, fieldErrors, run, fail, reset };
}

/* -------------------------------------------------------------------- loading */

export interface Loader<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** Write straight into the cache after a mutation that returned the new state. */
  set: (next: T) => void;
}

/**
 * Load a resource on mount and whenever `key` changes.
 *
 * `key` is a string rather than a dependency array so the caller has to name what
 * the request depends on, and a stale response from a superseded key is dropped
 * instead of overwriting a newer one.
 */
export function useLoader<T>(key: string, load: () => Promise<T>): Loader<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // Every request carries a sequence number; only the newest may write state.
  const latest = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const ticket = ++latest.current;
    let live = true;
    setLoading(true);
    setError(null);

    void loadRef
      .current()
      .then((result) => {
        if (!live || ticket !== latest.current) return;
        setData(result);
      })
      .catch((cause: unknown) => {
        if (!live || ticket !== latest.current) return;
        // A 401 here means the session ended; the auth provider is already
        // redirecting, so there is nothing useful to put on screen.
        if (cause instanceof ApiError && cause.isAuthError) return;
        setError(cause instanceof ApiError ? cause.message : 'Could not load this. Please try again.');
      })
      .finally(() => {
        if (live && ticket === latest.current) setLoading(false);
      });

    return () => {
      live = false;
    };
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const set = useCallback((next: T) => setData(next), []);

  return { data, error, loading, reload, set };
}
