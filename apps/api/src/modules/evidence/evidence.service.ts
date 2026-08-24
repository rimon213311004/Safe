import { Types } from 'mongoose';
import { fileTypeFromBuffer } from 'file-type';
import {
  ALLOWED_EVIDENCE_MIME,
  EVIDENCE_RELEASABLE_STATUSES,
  MAX_EVIDENCE_BYTES,
  type EvidenceKind,
} from '@safecheck/shared';
import { Evidence, Report, evidenceEncryption, type EvidenceDoc, type ReportDoc } from '../../models/index.js';
import {
  badRequest,
  forbidden,
  notFound,
  preconditionFailed,
} from '../../lib/errors.js';
import { AppError } from '../../lib/errors.js';
import { sha256Hex } from '../../lib/crypto.js';
import { recordAudit, type AuditContext } from '../../services/audit.service.js';
import { storage } from '../../storage/index.js';
import { enqueueEvidenceScan } from '../../queues/index.js';

/**
 * Evidence service.
 *
 * The rules that matter here:
 *
 *   • The declared MIME type is never trusted. We sniff magic bytes and reject
 *     anything whose real type isn't on the allow-list — otherwise `.jpg` is just
 *     a filename and an attacker uploads an HTML or SVG payload.
 *   • Bytes are handed straight to the storage driver, which encrypts them. The
 *     plaintext buffer is never written to disk by this layer.
 *   • Every read of an evidence file writes an audit row before the bytes are
 *     returned, because "who opened the photograph attached to this report" is a
 *     question an investigation must be able to answer.
 */

/** Map a verified MIME type onto the coarse kind stored on the document. */
function kindForMime(mime: string): EvidenceKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf' || mime === 'text/plain') return 'document';
  return 'other';
}

/**
 * Determine the true MIME type from the bytes themselves.
 *
 * `text/plain` has no magic number, so it is accepted only when the client
 * declared it AND the buffer contains no NUL byte — a cheap, conservative check
 * that keeps binaries from slipping through as "text".
 */
async function verifyMime(buffer: Buffer, declared: string): Promise<string> {
  const sniffed = await fileTypeFromBuffer(buffer);

  if (sniffed) {
    if (!(ALLOWED_EVIDENCE_MIME as readonly string[]).includes(sniffed.mime)) {
      throw badRequest(
        `That file appears to be ${sniffed.mime}, which isn't an accepted evidence type.`,
      );
    }
    return sniffed.mime;
  }

  if (declared === 'text/plain' && !buffer.includes(0)) return 'text/plain';

  throw badRequest("That file's type could not be verified, so it wasn't accepted.");
}

/* ------------------------------------------------------------------- upload */

export async function attachEvidence(params: {
  report: ReportDoc;
  uploaderId: string;
  filename: string;
  declaredMime: string;
  buffer: Buffer;
  caption?: string;
  context: AuditContext;
}): Promise<EvidenceDoc> {
  const { report, buffer } = params;

  if (report.reporterId.toString() !== params.uploaderId) {
    throw forbidden('Only the reporter can add evidence to this report.');
  }
  // Terminal states are closed to new material; a decided case reopens only
  // through the appeal route.
  if (report.status === 'decided' || report.status === 'withdrawn') {
    throw preconditionFailed(`Evidence cannot be added to a ${report.status} report.`);
  }
  if (buffer.byteLength === 0) throw badRequest('That file is empty.');
  if (buffer.byteLength > MAX_EVIDENCE_BYTES) {
    throw badRequest('That file is larger than the 50 MB limit.');
  }

  const mime = await verifyMime(buffer, params.declaredMime);

  // Encrypts before it lands, whichever driver is configured.
  const stored = await storage.put(buffer);

  const evidence = await Evidence.create({
    reportId: report._id,
    uploaderId: new Types.ObjectId(params.uploaderId),
    filename: params.filename,
    mime,
    kind: kindForMime(mime),
    sizeBytes: stored.sizeBytes,
    caption: params.caption ?? '',
    storageKey: stored.key,
    storageDriver: storage.name,
    contentHash: stored.contentHash,
    encryption: {
      algorithm: 'aes-256-gcm',
      iv: stored.iv,
      authTag: stored.authTag,
    },
    scanStatus: 'pending',
  });

  await Report.updateOne({ _id: report._id }, { $addToSet: { evidenceIds: evidence._id } });

  await recordAudit('evidence.uploaded', {
    context: params.context,
    targetType: 'Evidence',
    targetId: evidence._id.toString(),
    // Filename is intentionally omitted: users name files things like
    // "him-threatening-me.png".
    meta: { reportId: report._id.toString(), mime, sizeBytes: stored.sizeBytes },
  });

  await enqueueEvidenceScan(evidence._id.toString());

  return evidence;
}

/* ---------------------------------------------------------------- retrieval */

export interface EvidenceBytes {
  filename: string;
  mime: string;
  buffer: Buffer;
}

/**
 * Fetch and decrypt an evidence file for an authorised party.
 *
 * Authorisation, release-status, and audit all happen here so no route can
 * accidentally serve bytes without them.
 */
export async function readEvidence(params: {
  evidenceId: string;
  actorId: string;
  actorRole: string;
  context: AuditContext;
}): Promise<EvidenceBytes> {
  if (!Types.ObjectId.isValid(params.evidenceId)) throw notFound('File not found');

  const evidence = await Evidence.findById(params.evidenceId);
  if (!evidence) throw notFound('File not found');

  const report = await Report.findById(evidence.reportId);
  if (!report) throw notFound('File not found');

  const isReporter = report.reporterId.toString() === params.actorId;
  const isModerator = params.actorRole === 'moderator' || params.actorRole === 'admin';
  if (!isReporter && !isModerator) throw notFound('File not found');

  if (evidence.purgedAt) {
    throw new AppError('GONE', 'This file was removed under the retention policy.');
  }

  // Quarantined or unscanned material is withheld from the reporter but remains
  // reachable by moderators, who need to see exactly what was submitted.
  const releasable = (EVIDENCE_RELEASABLE_STATUSES as readonly string[]).includes(
    evidence.scanStatus,
  );
  if (!releasable && !isModerator) {
    throw preconditionFailed('This file is still being checked. Try again shortly.');
  }

  // Audited before the bytes leave, so a failure mid-transfer still leaves a trace.
  await recordAudit('evidence.accessed', {
    context: params.context,
    targetType: 'Evidence',
    targetId: evidence._id.toString(),
    meta: {
      reportId: report._id.toString(),
      asRole: isModerator && !isReporter ? 'moderator' : 'reporter',
      scanStatus: evidence.scanStatus,
    },
  });

  const buffer = await storage.get({
    key: evidence.storageKey,
    ...evidenceEncryption(evidence),
  });

  return { filename: evidence.filename, mime: evidence.mime, buffer };
}

/* --------------------------------------------------------------------- scan */

/**
 * Record a scan result. Pass 1 ships a structural check only — it verifies the
 * stored bytes still decrypt and match their recorded hash, which catches
 * corruption and tampering. A real deployment must additionally run malware and
 * CSAM detection here; that hook is the `scanNote` path below.
 */
export async function completeEvidenceScan(evidenceId: string): Promise<void> {
  const evidence = await Evidence.findById(evidenceId);
  if (!evidence || evidence.purgedAt) return;

  try {
    const buffer = await storage.get({
      key: evidence.storageKey,
      ...evidenceEncryption(evidence),
    });

    if (sha256Hex(buffer) !== evidence.contentHash) {
      evidence.scanStatus = 'quarantined';
      evidence.scanNote = 'Content hash did not match the value recorded at upload.';
    } else {
      evidence.scanStatus = 'clean';
      evidence.scanNote = 'Integrity verified. Malware/CSAM scanning not configured.';
    }
  } catch {
    evidence.scanStatus = 'failed';
    evidence.scanNote = 'Stored bytes could not be read for scanning.';
  }

  evidence.scannedAt = new Date();
  await evidence.save();
}
