/**
 * Connectivity and index sanity check.
 *   npm run db:check -w @safecheck/api
 *
 * Useful when the API won't boot: this isolates "can we reach Atlas at all"
 * from every other startup concern.
 */
import { connectDatabase, disconnectDatabase, mongoose } from '../db/connection.js';
import '../models/index.js';

async function main(): Promise<void> {
  const lines: string[] = [];
  try {
    await connectDatabase();
    const db = mongoose.connection.db;
    if (!db) throw new Error('no database handle after connect');

    lines.push('status     : CONNECTED');
    lines.push(`database   : ${mongoose.connection.name}`);
    lines.push(`host       : ${mongoose.connection.host}`);

    const cols = await db.listCollections().toArray();
    lines.push(`collections: ${cols.map((c) => c.name).sort().join(', ') || '(none — fresh)'}`);

    lines.push(`models     : ${Object.keys(mongoose.models).sort().join(', ')}`);
  } catch (err) {
    lines.push(`status     : FAILED`);
    lines.push(`error      : ${(err as Error).message}`);
    process.stdout.write(lines.join('\n') + '\n');
    await disconnectDatabase().catch(() => {});
    process.exitCode = 1;
    return;
  }
  process.stdout.write(lines.join('\n') + '\n');
  await disconnectDatabase();
}

await main();
