import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { IDENTIFIER_TYPES } from '@safecheck/shared';

/**
 * The person a report is *about*. They may have no SafeCheck account at all,
 * which is precisely why this model exists separately from User.
 *
 * ── The central privacy decision ────────────────────────────────────────────
 * Identifiers are stored ONLY as peppered HMAC-SHA256 hashes (see
 * lib/crypto.ts#hashIdentifier). Consequences, deliberately accepted:
 *
 *   • Lookup works: HMAC(query) → indexed exact match. O(1), no scan.
 *   • Enumeration does not: dumping this collection yields opaque hashes, not a
 *     browsable list of accused people. Without IDENTIFIER_PEPPER an attacker
 *     cannot even mount a dictionary attack over phone numbers.
 *   • Fuzzy/partial/name search is impossible by construction — not merely
 *     unimplemented. That is the point; it is the structural guarantee behind
 *     "you can check someone you already know, you cannot go fishing".
 *
 * `knownAs` is a moderator-facing label only. It is never used for matching and
 * never returned by the search API.
 */
const identifierSchema = new Schema(
  {
    type: { type: String, enum: IDENTIFIER_TYPES, required: true },
    /** Peppered HMAC of the normalised identifier. Never the plaintext. */
    hash: { type: String, required: true },
  },
  { _id: false },
);

const subjectProfileSchema = new Schema(
  {
    identifiers: { type: [identifierSchema], required: true },

    /** Set if we can confidently link this subject to a platform account. */
    linkedUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    /** Moderator-facing display label. Not searchable, not public. */
    knownAs: { type: String, default: '' },

    /**
     * Whether the subject has been told a report concerns them. Notification
     * must happen BEFORE any decision about them can become searchable — the
     * publication gate checks this timestamp against the appeal window.
     */
    notifiedAt: { type: Date, default: null },
    notificationChannel: { type: String, default: null },

    /**
     * Denormalised count of published (upheld + appeal-exhausted) records, kept
     * only as a cheap search hint. It is NEVER the source of truth for what is
     * disclosed — the search service always re-derives records through the
     * publication gate. Treat a stale value here as harmless.
     */
    publishedRecordCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

/**
 * The lookup index. Non-unique because two subjects could legitimately share a
 * hash only if they share an identifier, in which case they're the same person
 * and the service merges them.
 */
subjectProfileSchema.index({ 'identifiers.hash': 1 });

export type SubjectProfileDoc = InferSchemaType<typeof subjectProfileSchema> & {
  _id: Types.ObjectId;
};
export const SubjectProfile = model('SubjectProfile', subjectProfileSchema);
