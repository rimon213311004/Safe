import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { CASE_PRIORITIES, CASE_STATES } from '@safecheck/shared';

/**
 * The moderation workspace for one report. Separating this from Report keeps
 * moderator-internal state (notes, SLA, assignment) structurally apart from
 * anything a party can read — the party-facing serialisers never touch this
 * collection.
 */
const caseNoteSchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true },
    /** Only 'internal' exists today. Kept explicit so a future party-visible
     *  note type can't be introduced by accident. */
    visibility: { type: String, enum: ['internal'], default: 'internal' },
    createdAt: { type: Date, default: () => new Date() },
  },
  { _id: true },
);

const moderationCaseSchema = new Schema(
  {
    reportId: {
      type: Schema.Types.ObjectId,
      ref: 'Report',
      required: true,
      unique: true,
      index: true,
    },

    state: { type: String, enum: CASE_STATES, default: 'unassigned', index: true },
    priority: { type: String, enum: CASE_PRIORITIES, default: 'normal', index: true },

    /** True for grave categories; drives two-moderator publication review. */
    grave: { type: Boolean, default: false, index: true },

    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    assignedAt: { type: Date, default: null },

    notes: { type: [caseNoteSchema], default: [] },

    slaDueAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

moderationCaseSchema.index({ state: 1, priority: -1, createdAt: 1 });

/**
 * Hydrated, like ReportDoc: the moderation service mutates and saves these
 * documents (assign, change state, add notes). InferSchemaType alone omits the
 * `timestamps` fields and the instance methods, so both are added explicitly.
 */
type ModerationCaseFields = InferSchemaType<typeof moderationCaseSchema> & {
  createdAt: Date;
  updatedAt: Date;
};
export type ModerationCaseDoc = HydratedDocument<ModerationCaseFields>;
export const ModerationCase = model('ModerationCase', moderationCaseSchema);
