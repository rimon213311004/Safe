import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

/**
 * A login session, one per device/refresh-token family. Refresh tokens are
 * opaque and stored only as HMAC hashes; the plaintext lives solely in the
 * client's httpOnly cookie.
 *
 * Rotation: every use of a refresh token issues a new token in the same
 * `family` and marks the old one rotated. If a token that has already been
 * rotated is presented again, that's a reuse/theft signal — the whole family is
 * revoked. This is the standard refresh-token-rotation defence.
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Groups all rotations of one login together for reuse detection. */
    family: { type: String, required: true, index: true },

    refreshTokenHash: { type: String, required: true, index: true },

    /** Set when this token has been rotated to a successor. */
    rotatedAt: { type: Date, default: null },
    /** Set when the whole family is revoked (logout or reuse detected). */
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },

    /** Coarse device info for the account's session list. No fingerprinting. */
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// TTL index: expired sessions are reaped by MongoDB automatically.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SessionDoc = InferSchemaType<typeof sessionSchema> & { _id: Types.ObjectId };
export const Session = model('Session', sessionSchema);
