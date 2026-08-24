import { z } from 'zod';
import { EVIDENCE_KINDS } from '../enums.js';
import { objectId } from './common.js';

/**
 * Evidence is uploaded in two steps so large binaries never pass through JSON
 * validation and the server can enforce type/size before accepting bytes:
 *
 *   1. POST metadata  -> server returns an upload target / accepts multipart
 *   2. bytes are streamed, encrypted at rest, hashed, and queued for scanning
 *
 * Files are retrievable only via short-lived signed URLs, and only once the
 * scan status is releasable. They are never served from a static path.
 */

/** Accepted MIME types. Deliberately narrow — expand consciously. */
export const ALLOWED_EVIDENCE_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
  'text/plain',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'video/mp4',
  'video/webm',
] as const;
export type AllowedEvidenceMime = (typeof ALLOWED_EVIDENCE_MIME)[number];

export const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024; // 50 MB per file

/**
 * Caption for an uploaded file. Arrives as a multipart form field rather than
 * JSON, so it is validated on its own at the route.
 */
export const evidenceCaption = z.string().trim().max(500).default('');

export const initiateEvidenceUploadInput = z.object({
  reportId: objectId,
  filename: z.string().trim().min(1).max(255),
  mime: z.enum(ALLOWED_EVIDENCE_MIME),
  sizeBytes: z.number().int().positive().max(MAX_EVIDENCE_BYTES),
  /** Optional reporter note describing what this file shows. */
  caption: z.string().trim().max(500).optional(),
});
export type InitiateEvidenceUploadInput = z.infer<typeof initiateEvidenceUploadInput>;

/** Public evidence descriptor. Never exposes the storage key or raw bytes. */
export const evidenceItem = z.object({
  id: z.string(),
  reportId: z.string(),
  filename: z.string(),
  mime: z.string(),
  kind: z.enum(EVIDENCE_KINDS),
  sizeBytes: z.number().int(),
  caption: z.string().optional(),
  scanStatus: z.string(),
  /** True only when the item is currently fetchable by an authorised party. */
  releasable: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type EvidenceItem = z.infer<typeof evidenceItem>;

/** Response granting temporary access to an evidence item. */
export const evidenceAccessGrant = z.object({
  url: z.string(),
  expiresAt: z.iso.datetime(),
});
export type EvidenceAccessGrant = z.infer<typeof evidenceAccessGrant>;
