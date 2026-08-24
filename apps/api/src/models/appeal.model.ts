import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { APPEAL_PARTIES, APPEAL_STATES } from '@safecheck/shared';

/**
 * An appeal against an issued decision, from either the reporter or the subject.
 *
 * Two invariants enforced by the appeal service, not by this schema:
 *   • the reviewer must differ from the moderator who issued the decision;
 *   • while state is 'filed' or 'under_review', the decision cannot publish.
 */
const appealSchema = new Schema(
  {
    decisionId: { type: Schema.Types.ObjectId, ref: 'Decision', required: true, index: true },
    reportId: { type: Schema.Types.ObjectId, ref: 'Report', required: true, index: true },

    party: { type: String, enum: APPEAL_PARTIES, required: true },
    /** Null when the appellant is a subject with no platform account. */
    filedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    grounds: { type: String, required: true },
    state: { type: String, enum: APPEAL_STATES, default: 'filed', index: true },

    reviewerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolution: {
      decision: { type: String, enum: ['granted', 'denied'], default: null },
      rationale: { type: String, default: null },
      effect: {
        type: String,
        enum: ['vacate', 'amend', 'uphold_original'],
        default: null,
      },
    },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

appealSchema.index({ decisionId: 1, state: 1 });

/**
 * Hydrated: the appeal service mutates and saves these (claim, resolve,
 * withdraw), and `createdAt` is the appeal's filing time, which the party-facing
 * serialiser reports. InferSchemaType omits both, so they are added here.
 */
type AppealFields = InferSchemaType<typeof appealSchema> & {
  createdAt: Date;
  updatedAt: Date;
};
export type AppealDoc = HydratedDocument<AppealFields>;
export const Appeal = model('Appeal', appealSchema);
