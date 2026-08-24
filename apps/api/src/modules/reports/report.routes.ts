import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { reportSchemas, evidenceSchemas, appealSchemas } from '@safecheck/shared';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rate-limit.js';
import { body, params, query, validate } from '../../middleware/validate.js';
import { auditContextFromRequest } from '../../services/audit.service.js';
import { badRequest } from '../../lib/errors.js';
import { MAX_EVIDENCE_BYTES } from '@safecheck/shared';
import * as reportService from './report.service.js';
import * as evidenceService from '../evidence/evidence.service.js';
import * as appealService from '../appeals/appeal.service.js';

/**
 * Report routes.
 *
 * Everything here is authenticated. There is deliberately no public read route
 * for a report: the only way anything about an allegation reaches a non-party is
 * through the search module, behind the publication gate.
 */

/**
 * Uploads are buffered in memory rather than to a temp file. A 50 MB cap plus
 * memory storage means plaintext evidence never lands on the API server's disk,
 * even briefly — it goes from the request straight into the encrypting driver.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1 },
});

const idParam = z.object({ id: z.string() });

export const reportRouter = Router();

reportRouter.use(requireAuth);

/* ------------------------------------------------------------------- create */

reportRouter.post(
  '/',
  writeLimiter,
  validate({ body: reportSchemas.createReportInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const input = body<reportSchemas.CreateReportInput>(req);
    const report = await reportService.createReport({
      reporterId: req.auth!.userId,
      input,
      context: auditContextFromRequest(req),
    });
    res.status(201).json({ report: await reportService.toReportSummary(report) });
  }),
);

/* --------------------------------------------------------------------- list */

reportRouter.get(
  '/',
  validate({ query: reportSchemas.listReportsQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<reportSchemas.ListReportsQuery>(req);
    const reports = await reportService.listReportsForReporter({
      reporterId: req.auth!.userId,
      status: q.status,
      limit: q.limit,
    });
    res.status(200).json({ reports });
  }),
);

/* ------------------------------------------------------------------- detail */

reportRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<{ id: string }>(req);
    const report = await reportService.loadReportForActor({
      reportId: id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
    });

    const summary = await reportService.toReportSummary(report);
    const evidence = await reportService.listEvidenceForReport(report._id);
    const decision = await reportService.partyVisibleDecision(report);

    res.status(200).json({
      report: {
        ...summary,
        description: report.description,
        incidentAt: report.incidentAt?.toISOString(),
        location: report.location,
        evidenceIds: report.evidenceIds.map((e) => e.toString()),
        decision,
      },
      evidence,
    });
  }),
);

/* -------------------------------------------------------------- draft edits */

reportRouter.patch(
  '/:id',
  writeLimiter,
  validate({ params: idParam, body: reportSchemas.updateReportDraftInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<{ id: string }>(req);
    const report = await reportService.loadReportForActor({
      reportId: id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
    });
    const updated = await reportService.updateDraft({
      report,
      actorId: req.auth!.userId,
      input: body<reportSchemas.UpdateReportDraftInput>(req),
    });
    res.status(200).json({ report: await reportService.toReportSummary(updated) });
  }),
);

/* ------------------------------------------------------------------- submit */

reportRouter.post(
  '/:id/submit',
  writeLimiter,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<{ id: string }>(req);
    const report = await reportService.loadReportForActor({
      reportId: id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
    });
    const submitted = await reportService.submitReport({
      report,
      actorId: req.auth!.userId,
      context: auditContextFromRequest(req),
    });
    res.status(200).json({ report: await reportService.toReportSummary(submitted) });
  }),
);

/* ----------------------------------------------------------------- withdraw */

reportRouter.post(
  '/:id/withdraw',
  writeLimiter,
  validate({ params: idParam, body: reportSchemas.withdrawReportInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<{ id: string }>(req);
    const report = await reportService.loadReportForActor({
      reportId: id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
    });
    const withdrawn = await reportService.withdrawReport({
      report,
      actorId: req.auth!.userId,
      reason: body<reportSchemas.WithdrawReportInput>(req).reason,
      context: auditContextFromRequest(req),
    });
    res.status(200).json({ report: await reportService.toReportSummary(withdrawn) });
  }),
);

/* ------------------------------------------------------------ evidence add */

reportRouter.post(
  '/:id/evidence',
  writeLimiter,
  validate({ params: idParam }),
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<{ id: string }>(req);
    const file = req.file;
    if (!file) throw badRequest('Attach a file to upload.');

    // Caption arrives as a multipart field, so it is validated here rather than
    // by a body schema.
    const caption = evidenceSchemas.evidenceCaption.parse(req.body?.caption ?? '');

    const report = await reportService.loadReportForActor({
      reportId: id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
    });

    const evidence = await evidenceService.attachEvidence({
      report,
      uploaderId: req.auth!.userId,
      filename: file.originalname,
      declaredMime: file.mimetype,
      buffer: file.buffer,
      caption,
      context: auditContextFromRequest(req),
    });

    res.status(201).json({
      evidence: {
        id: evidence._id.toString(),
        filename: evidence.filename,
        mime: evidence.mime,
        kind: evidence.kind,
        sizeBytes: evidence.sizeBytes,
        caption: evidence.caption,
        scanStatus: evidence.scanStatus,
        createdAt: evidence.createdAt.toISOString(),
      },
    });
  }),
);

/* ----------------------------------------------------------------- appeals */

/**
 * Filing and listing appeals is nested under the report, mirroring evidence: an
 * appeal only exists against a report's decision, so the report is the natural
 * parent. Acting on an existing appeal lives on the appeals router instead.
 *
 * Note that filing does NOT go through `loadReportForActor`. That guard admits
 * the reporter and any moderator — but a *subject* must be able to appeal, and a
 * subject is neither. The appeal service checks entitlement for the specific
 * party being claimed, which is the stricter and correct check here.
 */
reportRouter.post(
  '/:id/appeals',
  writeLimiter,
  validate({ params: idParam, body: appealSchemas.fileAppealInput }),
  asyncHandler(async (req: Request, res: Response) => {
    const appeal = await appealService.fileAppeal({
      reportId: params<{ id: string }>(req).id,
      actorId: req.auth!.userId,
      input: body<appealSchemas.FileAppealInput>(req),
      context: auditContextFromRequest(req),
    });
    res.status(201).json({ appeal: appealService.toAppealDetail(appeal) });
  }),
);

reportRouter.get(
  '/:id/appeals',
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const report = await reportService.loadReportForActor({
      reportId: params<{ id: string }>(req).id,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
    });
    res.status(200).json({ appeals: await appealService.listAppealsForReport(report._id) });
  }),
);
