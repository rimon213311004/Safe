import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { connectDatabase, disconnectDatabase, mongoose } from '../db/connection.js';
import '../models/index.js';

/**
 * Shared integration-test lifecycle: one in-memory MongoDB per test file, wiped
 * between tests. Import this at the top of any *.test.ts that touches the
 * database and the hooks register themselves.
 *
 * We use a real (in-memory) Mongo rather than mocking Mongoose so that indexes,
 * unique constraints, and query behaviour are exercised for real — the bugs
 * worth catching live precisely in that layer.
 */

let mongod: MongoMemoryServer | undefined;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await connectDatabase(mongod.getUri());
}, 60_000);

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await disconnectDatabase();
  await mongod?.stop();
});
