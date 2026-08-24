import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { REPORT_CATEGORIES, REPORT_STATUSES } from '@safecheck/shared';

/**
 * An incident report.
 *
 * Note what is absent: there is no `public`, `visible`, or `verified` flag. A
 * report is always private to its reporter, the subject, and assigned
 * moderators. Publication is exclusively a property of a Decision, so no code
 * path can make a raw allegation visible. See domain/visibility.ts.
 */
const reportSchema = new Schema(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    subjectId: {
      type: Schema.Types.ObjectId,
      ref: 'SubjectProfile',
      required: true,
      index: true,
    },

    category: { type: String, enum: REPORT_CATEGORIES, required: true, index: true },
    status: { type: String, enum: REPORT_STATUSES, default: 'draft', index: true },

    description: { type: String, required: true },
    incidentAt: { type: Date, default: null },
    location: { type: String, default: '' },

    evidenceIds: [{ type: Schema.Types.ObjectId, ref: 'Evidence' }],

    /** The reporter's truthfulness attestation, recorded with a timestamp. */
    attestedAt: { type: Date, default: null },

    submittedAt: { type: Date, default: null },
    withdrawnAt: { type: Date, default: null },
    withdrawnReason: { type: String, default: null },

    /** Set once a decision exists, for cheap joins. */
    decisionId: { type: Schema.Types.ObjectId, ref: 'Decision', default: null },
  },
  { timestamps: true },
);

reportSchema.index({ reporterId: 1, createdAt: -1 });
reportSchema.index({ subjectId: 1, status: 1 });

/**
 * The hydrated document type — it carries the timestamp fields (which
 * InferSchemaType omits) and the instance methods like `.save()` that services
 * rely on.
 */
type ReportFields = InferSchemaType<typeof reportSchema> & {
  createdAt: Date;
  updatedAt: Date;
};
export type ReportDoc = HydratedDocument<ReportFields>;
export const Report = model('Report', reportSchema);
