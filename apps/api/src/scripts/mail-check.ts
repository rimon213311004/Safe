import { env } from '../config/env.js';
import { mailer } from '../services/messaging.service.js';

/**
 * Sends one real message through the configured mail driver. Run with
 * `npm run mail:check -w @safecheck/api -- you@example.com`.
 *
 * This exists so that SMTP credentials can be proven before a real person
 * depends on them. Verification codes are stored only as hashes, so a silently
 * broken transport does not surface as an error anywhere — it surfaces as a user
 * who never receives a code and cannot be helped, since the code cannot be read
 * back out of the database. Better to find out here.
 */
async function main(): Promise<void> {
  const to = process.argv[2];
  if (!to || !to.includes('@')) {
    console.error('Usage: npm run mail:check -w @safecheck/api -- you@example.com');
    process.exit(2);
  }

  console.log(`driver : ${env.MAIL_DRIVER}`);
  console.log(`from   : ${env.MAIL_FROM}`);
  if (env.MAIL_DRIVER === 'smtp') {
    const target = env.SMTP_URL
      ? env.SMTP_URL.replace(/\/\/[^@]*@/, '//***@') // never print the password
      : `${env.SMTP_HOST}:${env.SMTP_PORT} (${env.SMTP_USER ? 'authenticated' : 'no auth'})`;
    console.log(`relay  : ${target}`);
  }

  // Shaped like the real thing: a six-digit code is what a user will receive.
  const code = String(Math.floor(100000 + Math.random() * 900000));
  console.log(`\nsending to ${to}...`);

  await mailer.send({
    to,
    subject: 'SafeCheck delivery test',
    body:
      `This is a delivery test from SafeCheck.\n\n` +
      `  Sample code: ${code}\n\n` +
      `If this reached your inbox, verification emails will too. Nothing was\n` +
      `created or changed in the database — this code means nothing.\n`,
  });

  console.log('\nAccepted by the relay.');
  if (env.MAIL_DRIVER === 'console') {
    console.log('Driver is `console`, so the message above was printed, not delivered.');
    console.log('Set MAIL_DRIVER=smtp with credentials to reach a real inbox — see .env.example.');
  } else {
    console.log('Check the inbox, and the spam folder — first sends from a new sender often land there.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('\nMail check FAILED:');
    console.error(err);
    // The cause carries the relay's own words ("535 authentication failed",
    // "getaddrinfo ENOTFOUND"), which is the part worth reading.
    if (err instanceof Error && err.cause) console.error('\ncause:', err.cause);
    process.exit(1);
  });
