import { z } from 'zod';
import { APPEAL_PARTIES, APPEAL_STATES } from '../enums.js';
import { narrative } from './common.js';

/**
 * Appeals. Either party (reporter or subject) may appeal an issued decision
 * within the appeal window. An appeal must be reviewed by a moderator OTHER
 * than the one who issued the decision — enforced in the service layer.
 *
 * While an appeal is pending, the underlying decision can never be publishable.
 */

export const fileAppealInput = z.object({
  /** Which party is appealing. The server checks the caller is entitled to it. */
  party: z.enum(APPEAL_PARTIES),
  grounds: narrative(30, 4000),
});
export type FileAppealInput = z.infer<typeof fileAppealInput>;

export const resolveAppealInput = z
  .object({
    decision: z.enum(['granted', 'denied']),
    rationale: narrative(20, 4000),
    /**
     * When granted, what happens to the original decision. `vacate` removes any
     * publishability and reopens the case; `amend` records a corrected outcome.
     */
    effect: z.enum(['vacate', 'amend', 'uphold_original']).optional(),
  })
  .refine((v) => v.decision === 'denied' || Boolean(v.effect), {
    error: 'Specify the effect on the original decision when granting an appeal',
    path: ['effect'],
  });
export type ResolveAppealInput = z.infer<typeof resolveAppealInput>;

/* ------------------------------------------------------------ public shapes */

export const appealSummary = z.object({
  id: z.string(),
  reportId: z.string(),
  party: z.enum(APPEAL_PARTIES),
  state: z.enum(APPEAL_STATES),
  filedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type AppealSummary = z.infer<typeof appealSummary>;

export const appealDetail = appealSummary.extend({
  grounds: z.string(),
  resolution: z
    .object({
      decision: z.enum(['granted', 'denied']),
      rationale: z.string(),
      effect: z.string().nullable(),
    })
    .nullable(),
});
export type AppealDetail = z.infer<typeof appealDetail>;
