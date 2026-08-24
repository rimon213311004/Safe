import { z } from 'zod';
import { email, phone } from './common.js';

/**
 * Search is the platform's most sensitive surface. The request accepts exactly
 * one exact identifier — there is no partial, fuzzy, name, or wildcard search,
 * by design. You can confirm something about an identifier you already know;
 * you cannot browse or enumerate people.
 *
 * The response NEVER contains pending, undecided, or unpublished report data.
 * See domain/visibility.ts in the API for the single gate that enforces this.
 */

export const searchInput = z
  .object({
    email: email.optional(),
    phone: phone.optional(),
  })
  .refine(
    (v) => [v.email, v.phone].filter(Boolean).length === 1,
    { error: 'Search by exactly one identifier: an email or a phone number' },
  );
export type SearchInput = z.infer<typeof searchInput>;

/**
 * A single adjudicated, published safety record. Contains an outcome and coarse
 * timing only — never the narrative, the evidence, or the reporter's identity.
 */
export const publishedRecord = z.object({
  category: z.string(),
  outcome: z.literal('upheld'),
  /** Month precision only, e.g. "2025-11". Never a precise timestamp. */
  decidedMonth: z.string().regex(/^\d{4}-\d{2}$/),
  appealStatus: z.enum(['exhausted', 'none_filed']),
});
export type PublishedRecord = z.infer<typeof publishedRecord>;

/**
 * The search result. Distinguishes three things a searcher legitimately wants:
 *  - whether the identifier maps to a verified SafeCheck account,
 *  - what that account chose to self-publish,
 *  - any fully-adjudicated, appeal-exhausted, published safety records.
 *
 * `matched=false` means the identifier is unknown to us. It deliberately does
 * NOT distinguish "no account" from "account with nothing published" beyond the
 * fields below, to avoid leaking the existence of private reports.
 */
export const searchResult = z.object({
  matched: z.boolean(),
  account: z
    .object({
      verified: z.boolean(),
      verifiedMonth: z.string().regex(/^\d{4}-\d{2}$/).nullable(),
      /** Only what the account holder explicitly chose to make public. */
      selfPublished: z.array(z.string()),
    })
    .nullable(),
  records: z.array(publishedRecord),
  /**
   * Always present, always the same wording regardless of whether private
   * reports exist — so response shape can't be used to infer hidden reports.
   */
  disclaimer: z.string(),
});
export type SearchResult = z.infer<typeof searchResult>;

/** Fixed disclaimer text. Centralised so UI and API can't drift. */
export const SEARCH_DISCLAIMER =
  'SafeCheck shows only identity verification and safety outcomes that have completed ' +
  'moderation review and passed their appeal window. Reports under review are never ' +
  'shown. The absence of records does not imply anything about a person.';
