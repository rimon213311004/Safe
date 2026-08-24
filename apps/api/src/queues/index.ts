import { Queue, Worker, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { env, hasRedis } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Background jobs.
 *
 * BullMQ needs Redis. Rather than make Redis mandatory for local development, an
 * absent REDIS_URL causes each `enqueue*` call to run its handler inline. The
 * call sites are identical either way, so the code path exercised in dev is the
 * same one that runs in production — only the scheduling differs.
 *
 * Inline execution deliberately does NOT await the handler at the call site's
 * expense: failures are logged, never propagated, so a scan failure cannot make
 * an upload appear to fail.
 */

type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

const QUEUE_NAMES = ['evidence-scan', 'notifications', 'retention'] as const;
type QueueName = (typeof QUEUE_NAMES)[number];

const handlers = new Map<QueueName, JobHandler>();
const queues = new Map<QueueName, Queue>();
const workers: Worker[] = [];

let connection: Redis | undefined;

function redis(): Redis {
  connection ??= new Redis(env.REDIS_URL, {
    // BullMQ requires this; without it blocking commands throw.
    maxRetriesPerRequest: null,
  });
  return connection;
}

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 200,
  removeOnFail: 500,
};

/** Register the handler for a queue. Called once per queue during startup. */
export function registerHandler(name: QueueName, handler: JobHandler): void {
  handlers.set(name, handler);

  if (!hasRedis) return;

  const worker = new Worker(name, async (job) => handler(job.data as Record<string, unknown>), {
    connection: redis(),
  });
  worker.on('failed', (job, err) => {
    logger.error({ err, queue: name, jobId: job?.id }, 'job failed');
  });
  workers.push(worker);
}

async function enqueue(name: QueueName, payload: Record<string, unknown>): Promise<void> {
  if (hasRedis) {
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: redis(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
      queues.set(name, queue);
    }
    await queue.add(name, payload);
    return;
  }

  const handler = handlers.get(name);
  if (!handler) {
    logger.warn({ queue: name }, 'no handler registered; job dropped');
    return;
  }
  try {
    await handler(payload);
  } catch (err) {
    logger.error({ err, queue: name }, 'inline job failed');
  }
}

/* ------------------------------------------------------------- public API */

export async function enqueueEvidenceScan(evidenceId: string): Promise<void> {
  await enqueue('evidence-scan', { evidenceId });
}

export async function enqueueNotification(payload: {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  await enqueue('notifications', { ...payload });
}

export async function enqueueRetentionSweep(): Promise<void> {
  await enqueue('retention', {});
}

/** Close queue and worker connections during graceful shutdown. */
export async function closeQueues(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all([...queues.values()].map((q) => q.close()));
  if (connection) {
    connection.disconnect();
    connection = undefined;
  }
}

export { hasRedis };
export type { QueueName };
