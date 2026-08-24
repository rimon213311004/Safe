import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { EVIDENCE_KINDS, EVIDENCE_SCAN_STATUSES } from '@safecheck/shared';

/**
 * An uploaded evidence file.
 *
 * The bytes live in the storage driver, encrypted with AES-256-GCM. This
 * document holds the metadata needed to locate and decrypt them, plus the
 * integrity hash of the *plaintext* so tampering is detectable.
 *
 * Evidence is never served from a static path. Access is granted only through a
 * short-lived signed URL, to an authorised party, and every access appends an
 * AuditLog entry — because "who looked at the intimate photograph attached to
 * this report" is exactly the question an investigation needs to answer.
 */
const evidenceSchema = new Schema(
  {
    reportId: { type: Schema.Types.ObjectId, ref: 'Report', required: true, index: true },
    uploaderId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    filename: { type: String, required: true },
    /** MIME as *verified by magic-byte sniffing*, not as declared by the client. */
    mime: { type: String, required: true },
    kind: { type: String, enum: EVIDENCE_KINDS, required: true },
    sizeBytes: { type: Number, required: true },
    caption: { type: String, default: '' },

    /** Opaque key within the storage driver. Never exposed to any client. */
    storageKey: { type: String, required: true },
    storageDriver: { type: String, enum: ['local', 's3', 'cloudinary'], required: true },

    /** SHA-256 of the plaintext, for integrity and duplicate detection. */
    contentHash: { type: String, required: true, index: true },

    /** AES-256-GCM parameters. The key itself comes from env, never from here. */
    encryption: {
      algorithm: { type: String, default: 'aes-256-gcm' },
      iv: { type: String, required: true }, // base64
      authTag: { type: String, required: true }, // base64
    },

    scanStatus: {
      type: String,
      enum: EVIDENCE_SCAN_STATUSES,
      default: 'pending',
      index: true,
    },
    scanNote: { type: String, default: '' },
    scannedAt: { type: Date, default: null },

    /** Purged by the retention job; the document is kept as a tombstone. */
    purgedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * The hydrated document type — carries timestamp fields (omitted by
 * InferSchemaType) and instance methods like `.save()`.
 *
 * Mongoose infers the embedded `encryption` object as optional even though its
 * inner fields are required, so services read it through
 * `evidenceEncryption(doc)` below rather than trusting it to be present.
 */
type EvidenceFields = InferSchemaType<typeof evidenceSchema> & {
  createdAt: Date;
  updatedAt: Date;
};
export type EvidenceDoc = HydratedDocument<EvidenceFields>;
export const Evidence = model('Evidence', evidenceSchema);

/** Narrow the optionally-typed embedded encryption block to its real shape. */
export function evidenceEncryption(doc: EvidenceDoc): {
  iv: string;
  authTag: string;
} {
  const enc = doc.encryption;
  if (!enc?.iv || !enc?.authTag) {
    throw new Error(`Evidence ${doc._id.toString()} is missing its encryption metadata`);
  }
  return { iv: enc.iv, authTag: enc.authTag };
}
