import { storage } from '../storage/index.js';
import { env } from '../config/env.js';

/**
 * Adversarial check on the Cloudinary evidence driver.
 *
 * The claim being tested is the one the whole platform rests on: evidence must
 * not be fetchable by URL. This uploads a file and then attacks it the way an
 * outsider would — guessing the public delivery URL for both `upload` and
 * `private` asset types, and trying an unsigned raw fetch.
 *
 * Every one of those must fail. If any succeeds, the encryption is the only
 * thing left standing between an attacker and someone's evidence, and that is
 * not an acceptable margin.
 */
async function main(): Promise<void> {
  if (storage.name !== 'cloudinary') {
    console.log(`storage driver is "${storage.name}" — this check targets cloudinary. Skipping.`);
    return;
  }

  const plaintext = Buffer.from('SENSITIVE-EVIDENCE-CANARY-DO-NOT-LEAK', 'utf8');
  const stored = await storage.put(plaintext);
  console.log(`uploaded canary as: ${stored.key}\n`);

  const cloud = env.CLOUDINARY_CLOUD_NAME;
  const candidates = [
    `https://res.cloudinary.com/${cloud}/raw/upload/${stored.key}`,
    `https://res.cloudinary.com/${cloud}/raw/private/${stored.key}`,
    `https://res.cloudinary.com/${cloud}/image/upload/${stored.key}`,
    `https://res.cloudinary.com/${cloud}/raw/authenticated/${stored.key}`,
  ];

  let leaked = false;

  for (const url of candidates) {
    let verdict: string;
    try {
      const res = await fetch(url);
      const bytes = Buffer.from(await res.arrayBuffer());

      if (res.ok && bytes.includes('SENSITIVE-EVIDENCE-CANARY')) {
        verdict = `LEAKED PLAINTEXT (${res.status})`;
        leaked = true;
      } else if (res.ok) {
        // Reachable but ciphertext. Still a finding: it means the asset is
        // publicly addressable and only encryption is protecting it.
        verdict = `reachable but ciphertext (${res.status}) — asset is public!`;
        leaked = true;
      } else {
        verdict = `blocked (${res.status})`;
      }
    } catch (err) {
      verdict = `blocked (network: ${(err as Error).message.slice(0, 40)})`;
    }
    console.log(`  ${verdict.padEnd(46)} ${url}`);
  }

  await storage.delete(stored.key);
  console.log('\ncanary deleted');

  if (leaked) {
    console.error('\nFAIL: evidence was reachable without a signed URL.');
    process.exit(1);
  }
  console.log('PASS: no public URL serves this asset. Retrieval requires a signed URL.');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('check errored:', err);
    process.exit(1);
  });
