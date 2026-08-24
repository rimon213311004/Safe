import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler, requestId } from './middleware/error.js';
import { registerQueueHandlers } from './queues/register.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { reportRouter } from './modules/reports/report.routes.js';
import { evidenceRouter } from './modules/evidence/evidence.routes.js';
import { searchRouter } from './modules/search/search.routes.js';
import { moderationRouter } from './modules/moderation/moderation.routes.js';
import { appealRouter } from './modules/appeals/appeal.routes.js';
import { notificationRouter } from './modules/notifications/notification.routes.js';

/**
 * Builds the Express app without binding a port, so the integration suite can
 * drive it through supertest with no network involved.
 */
export function createApp(): Express {
  const app = express();

  // Background handlers must exist before any request can enqueue work — with no
  // Redis configured, enqueueing runs the handler inline.
  registerQueueHandlers();

  // Trust the first proxy hop so req.ip is the client, not the load balancer.
  // Rate limiting and audit IP hashing both depend on this being right.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true, // required for the refresh cookie
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestId);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', env: env.NODE_ENV, time: new Date().toISOString() });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/reports', reportRouter);
  app.use('/api/evidence', evidenceRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/moderation', moderationRouter);
  app.use('/api/appeals', appealRouter);
  app.use('/api/notifications', notificationRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
