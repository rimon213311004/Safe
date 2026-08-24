import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { AUDIT_ACTIONS } from '@safecheck/shared';

/**
 * Append-only audit trail.
 *
 * Nothing in the application updates or deletes these rows — the service layer
 * exposes only an append operation. This is what makes it possible to answer,
 * after the fact: who read this evidence, who decided this case, who made a
 * record about a person searchable, and who searched for whom.
 *
 * `ipHash` rather than `ip`: enough to correlate activity from one source
 * without retaining a plaintext location trail on people reporting abuse.
 */
const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorRole: { type: String, default: null },

    action: { type: String, enum: AUDIT_ACTIONS, required: true, index: true },

    targetType: { type: String, default: null },
    targetId: { type: String, default: null, index: true },

    /** Small, non-sensitive context. Never put narratives or identifiers here. */
    meta: { type: Schema.Types.Mixed, default: {} },

    ipHash: { type: String, default: null },
    userAgent: { type: String, default: '' },

    at: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: false },
);

auditLogSchema.index({ action: 1, at: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, at: -1 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema> & { _id: Types.ObjectId };
export const AuditLog = model('AuditLog', auditLogSchema);
