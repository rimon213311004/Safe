import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Single shared Mongoose connection. Import `connectDatabase` from the server
 * entrypoint and from the test harness; models register themselves against the
 * default connection on import.
 */

mongoose.set('strictQuery', true);

let connected = false;

export async function connectDatabase(uri: string = env.MONGODB_URI): Promise<void> {
  if (connected) return;
  mongoose.connection.on('error', (err) => logger.error({ err }, 'mongodb error'));
  mongoose.connection.on('disconnected', () => {
    connected = false;
    logger.warn('mongodb disconnected');
  });
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    autoIndex: env.NODE_ENV !== 'production', // build indexes explicitly in prod
  });
  connected = true;
  logger.info('mongodb connected');
}

export async function disconnectDatabase(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}

export { mongoose };
