import { storage } from '../storage/index.js';
import { env } from '../config/env.js';
import { sha256Hex } from '../lib/crypto.js';

/**
 * Verifies the configured storage driver end to end: encrypt → upload → fetch →
 * decrypt → compare, then clean up. Run with `npm run storage:check`.
 *
 * Worth having as a script rather than only a unit test, because the failure
 * modes that matter for Cloudinary (bad credentials, private-asset delivery,
 * signed-URL expiry) only appear against the real service.
 */
async function main(): Promise<void> {
  console.log(`storage driver: ${storage.name}`);
  if (storage.name === 'cloudinary') {
    console.log(`cloud: ${env.CLOUDINARY_CLOUD_NAME}, folder: ${env.CLOUDINARY_EVIDENCE_FOLDER}`);
  }

  // A tiny valid PNG, so the payload resembles real evidence.
  const plaintext = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  const expected = sha256Hex(plaintext);

  console.log(`\nuploading ${plaintext.byteLength} bytes...`);
  const stored = await storage.put(plaintext);
  console.log(`  key:         ${stored.key}`);
  console.log(`  contentHash: ${stored.contentHash.slice(0, 16)}...`);
  console.log(`  iv/authTag:  present (${stored.iv.length}/${stored.authTag.length} b64 chars)`);

  if (stored.contentHash !== expected) {
    throw new Error('contentHash does not match the plaintext hash');
  }

  console.log('\nfetching and decrypting...');
  const roundTripped = await storage.get(stored);

  if (!roundTripped.equals(plaintext)) {
    throw new Error('round-tripped bytes differ from the original');
  }
  console.log('  bytes match the original exactly');

  console.log('\ndeleting...');
  await storage.delete(stored.key);
  console.log('  deleted');

  console.log('\nStorage round-trip OK.');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('\nStorage check FAILED:');
    console.error(err);
    process.exit(1);
  });
