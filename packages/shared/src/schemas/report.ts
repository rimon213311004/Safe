import { z } from 'zod';
import { REPORT_CATEGORIES } from '../enums.js';
import { email, narrative, objectId, phone } from './common.js';

/**
 * How the reporter identifies the person a report concerns. The server hashes
 * the raw value with a pepper before storage — the plaintext identifier is
 * never persisted. At least one identifier is required so the subject can be
 * matched across reports and, eventually, notified.
 */
export const subjectIdentifierInput = z
  .object({
    email: email.optional(),
    phone: phone.optional(),
    /** Optional display label shown to moderators; not used for matching. */
    knownAs: z.string().trim().max(120).optional(),
  })
  .refine((v) => Boolean(v.email ?? v.phone), {
    error: 'Provide at least an email or a phone number for the person',
  });
export type SubjectIdentifierInput = z.infer<typeof subjectIdentifierInput>;

export const reportCategory = z.enum(REPORT_CATEGORIES);

/* --------------------------------------------------------------- create/edit */

export const createReportInput = z.object({
  category: reportCategory,
  subject: subjectIdentifierInput,
  /** What happened. Bounded but generous; this is the core of the report. */
  description: narrative(40, 8000),
  /** When the incident(s) occurred, reporter-supplied. */
  incidentAt: z.iso.datetime().optional(),
  /** Free-text location, optional and coarse by design (no precise geo). */
  location: z.string().trim().max(200).optional(),
  /**
   * The reporter attests the account is truthful. Recorded with the report;
   * false reporting has consequences. Must be explicitly true.
   */
  attestation: z.literal(true, {
    error: 'You must confirm the report is truthful to submit',
  }),
  /** Optional: submit immediately vs. save as a draft to add evidence first. */
  submitNow: z.boolean().default(true),
});
export type CreateReportInput = z.infer<typeof createReportInput>;

export const updateReportDraftInput = z.object({
  description: narrative(40, 8000).optional(),
  incidentAt: z.iso.datetime().optional(),
  location: z.string().trim().max(200).optional(),
});
export type UpdateReportDraftInput = z.infer<typeof updateReportDraftInput>;

export const withdrawReportInput = z.object({
  reason: narrative(5, 1000),
});
export type WithdrawReportInput = z.infer<typeof withdrawReportInput>;

export const listReportsQuery = z.object({
  status: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListReportsQuery = z.infer<typeof listReportsQuery>;

/* ------------------------------------------------------------- public shapes */

/** A report as shown to its reporter. Excludes moderator-internal fields. */
export const reportSummary = z.object({
  id: z.string(),
  category: reportCategory,
  status: z.string(),
  subjectLabel: z.string(),
  evidenceCount: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ReportSummary = z.infer<typeof reportSummary>;

export const reportDetail = reportSummary.extend({
  description: z.string(),
  incidentAt: z.iso.datetime().optional(),
  location: z.string().optional(),
  evidenceIds: z.array(objectId),
  /** Party-visible outcome, present only once a decision has been issued. */
  decision: z
    .object({
      outcome: z.string(),
      rationale: z.string(),
      issuedAt: z.iso.datetime(),
      appealWindowEndsAt: z.iso.datetime(),
      canAppeal: z.boolean(),
    })
    .nullable(),
});
export type ReportDetail = z.infer<typeof reportDetail>;
