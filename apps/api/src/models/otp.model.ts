import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

/**
 * A one-time passcode challenge (email verification, login 2FA). The code is
 * stored only as a hash; it is compared in constant time and consumed on use.
 * Attempts are capped so a 6-digit code can't be brute-forced within its TTL.
 */
const otpSchema = new Schema(
  {
    /** Who this is for. We key by email so it works pre-account-verification. */
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    purpose: {
      type: String,
      enum: ['verify_email', 'login', 'password_reset'],
      required: true,
    },

    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },

    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpSchema.index({ email: 1, purpose: 1, consumedAt: 1 });

export type OtpDoc = InferSchemaType<typeof otpSchema> & { _id: Types.ObjectId };
export const Otp = model('Otp', otpSchema);
