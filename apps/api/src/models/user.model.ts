import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { ROLES } from '@safecheck/shared';

/**
 * A platform account. Passwords are argon2id hashes (see auth service) — this
 * model never stores plaintext. Email is stored in plaintext here because it is
 * the account's own login identity; subject identifiers on *reports* are hashed
 * instead (see SubjectProfile).
 */
const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: 'user', index: true },

    emailVerified: { type: Boolean, default: false },
    twoFactorEnabled: { type: Boolean, default: false },

    /** Identity verification of the account holder (Pass 2 wires the flow). */
    identityStatus: {
      type: String,
      enum: ['unverified', 'pending', 'verified', 'rejected'],
      default: 'unverified',
    },
    identityVerifiedAt: { type: Date, default: null },

    /** Facts the user chose to make publicly visible in search results. */
    selfPublished: { type: [String], default: [] },

    /** Soft lock after repeated failed logins. */
    lockedUntil: { type: Date, default: null },
    failedLoginCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// NOTE: no explicit email index here — `unique: true` on the field already
// creates it. Declaring both makes Mongoose warn about a duplicate index.

/** InferSchemaType omits the fields added by `timestamps: true`, so add them. */
export type UserDoc = InferSchemaType<typeof userSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const User = model('User', userSchema);
