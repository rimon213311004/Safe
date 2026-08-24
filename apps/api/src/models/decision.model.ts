import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { DECISION_OUTCOMES } from '@safecheck/shared';

/**
 * A moderator's adjudication of a report.
 *
 * The two fields that matter most for safety:
 *
 *   `outcome`     — only 'upheld' is ever eligible for publication.
 *   `publishable` — a SEPARATE, explicit act, defaulting to false. Issuing a
 *                   decision never publishes it. For grave categories the
 *                   service additionally requires that `publishableSetBy`
 *                   differs from `issuedBy`, so two humans must agree before
 *                   anything about a person becomes searchable.
 *
 * Even with publishable=true a record stays hidden until the appeal window
 * closes with no pending appeal and the subject has been notified. That
 * conjunction lives in exactly one place: domain/visibility.ts.
 */
const decisionSchema = new Schema(
  {
    /**
     * Indexed but NOT unique. A report can accumulate a decision history: if an
     * appeal vacates a decision, that decision stays on record and a fresh one is
     * issued alongside it. Overwriting would destroy the appeal trail, which is
     * the one record most likely to matter later. The service invariant is
     * therefore "at most one decision per report with vacatedAt === null", and it
     * is enforced in moderation.service.ts#issueDecision rather than by the index.
     */
    reportId: {
      type: Schema.Types.ObjectId,
      ref: 'Report',
      required: true,
      index: true,
    },
    caseId: { type: Schema.Types.ObjectId, ref: 'ModerationCase', required: true, index: true },
    subjectId: {
      type: Schema.Types.ObjectId,
      ref: 'SubjectProfile',
      required: true,
      index: true,
    },

    outcome: { type: String, enum: DECISION_OUTCOMES, required: true, index: true },
    /** Written for the parties, not internal shorthand. Shown to both sides. */
    rationale: { type: String, required: true },

    issuedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    issuedAt: { type: Date, required: true, default: () => new Date() },

    publishable: { type: Boolean, default: false, index: true },
    publishableSetBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    publishableSetAt: { type: Date, default: null },
    publicationReviewNote: { type: String, default: '' },

    /** Appeals filed at or before this instant block publication. */
    appealWindowEndsAt: { type: Date, required: true, index: true },

    /** Set if an appeal vacated this decision; vacated decisions never publish. */
    vacatedAt: { type: Date, default: null },
    vacatedReason: { type: String, default: null },
  },
  { timestamps: true },
);

decisionSchema.index({ reportId: 1, vacatedAt: 1 });

/** Hydrated: the service mutates and saves these documents (vacate, publish). */
export type DecisionDoc = HydratedDocument<InferSchemaType<typeof decisionSchema>>;
export const Decision = model('Decision', decisionSchema);
