import nodemailer, { type Transporter } from 'nodemailer';
import { env, isTest } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Outbound message transports.
 *
 * In development both drivers write to stdout so you can complete the OTP flow
 * without configuring a provider — the code is printed, deliberately and only
 * when MAIL_DRIVER=console. Wiring a real provider (Resend/SES/Twilio) means
 * implementing the interface below; nothing else in the app changes.
 *
 * MAIL_DRIVER=smtp reaches every mail provider worth using through one code
 * path, because they all speak SMTP — Gmail, Brevo, Resend, SES, Mailtrap. See
 * .env.example for the credentials each one wants; the code below does not care
 * which you picked.
 */

export interface OutboundMessage {
  to: string;
  subject: string;
  body: string;
}

export interface MailTransport {
  send(message: OutboundMessage): Promise<void>;
}

/** Dev transport: prints to stdout. Never enable in production. */
class ConsoleMailTransport implements MailTransport {
  async send(message: OutboundMessage): Promise<void> {
    const line = '─'.repeat(64);
    process.stdout.write(
      `\n${line}\n  EMAIL (console driver — dev only)\n  to      : ${message.to}\n` +
        `  subject : ${message.subject}\n${line}\n${message.body}\n${line}\n\n`,
    );
  }
}

/**
 * Two ways to point this at a provider, both handled here:
 *
 *   SMTP_URL=smtps://user:pass@smtp.example.com:465
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
 *
 * The discrete variables exist because a URL has to percent-encode its
 * password, and a pasted password containing `@` or `/` produces an
 * authentication failure that looks nothing like an encoding bug. If both are
 * present the URL wins.
 */
function smtpConnection() {
  const url = env.SMTP_URL.trim();
  if (url) return url;
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 is implicit TLS; 587 and 2525 open in the clear and upgrade via
    // STARTTLS, which nodemailer does on its own when `secure` is false.
    secure: env.SMTP_PORT === 465,
    // Spread rather than `auth: undefined` — an unauthenticated relay (a local
    // Mailpit, say) must not send an empty AUTH command.
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}),
  };
}

class SmtpMailTransport implements MailTransport {
  /**
   * Built on first send rather than at import. Nothing connects until a message
   * is actually going out, so a bad SMTP_URL surfaces as a failed send with a
   * logged reason instead of a crash during module loading — and the boot check
   * in config/env.ts has already rejected the obvious misconfigurations.
   */
  #transporter: Transporter | null = null;

  #resolve(): Transporter {
    this.#transporter ??= nodemailer.createTransport(smtpConnection(), {
      from: env.MAIL_FROM,
    });
    return this.#transporter;
  }

  async send(message: OutboundMessage): Promise<void> {
    try {
      const receipt = await this.#resolve().sendMail({
        to: message.to,
        subject: message.subject,
        text: message.body,
      });
      // Deliberately no recipient in the log line. This transport carries
      // verification codes to addresses the rest of the system only ever stores
      // as keyed hashes; writing them to a log would undo that.
      logger.info({ messageId: receipt.messageId }, 'Mail accepted by SMTP relay');
    } catch (cause) {
      logger.error({ err: cause }, 'SMTP delivery failed');
      // The caller turns this into a 502-style response. The reason stays in the
      // logs: it can name the relay host and the account, neither of which
      // belongs in an HTTP body.
      throw new Error('Could not send the verification email. Try again shortly.', { cause });
    }
  }
}

/**
 * Test transport: keeps sent messages in memory so the integration suite can
 * assert on them and extract OTP codes.
 *
 * This exists because OTPs are stored only as hashes — by design, there is no
 * way to read a code back out of the database, not even in a test. Capturing the
 * outbound message is the only honest way to complete the flow, and it exercises
 * the same code path a real user would.
 */
class MemoryMailTransport implements MailTransport {
  readonly sent: OutboundMessage[] = [];
  async send(message: OutboundMessage): Promise<void> {
    this.sent.push(message);
  }
}

export const capturedMail = new MemoryMailTransport();

export const mailer: MailTransport = isTest
  ? capturedMail
  : env.MAIL_DRIVER === 'console'
    ? new ConsoleMailTransport()
    : new SmtpMailTransport();

/* ---------------------------------------------------------------------- sms */

export interface SmsTransport {
  send(to: string, body: string): Promise<void>;
}

class ConsoleSmsTransport implements SmsTransport {
  async send(to: string, body: string): Promise<void> {
    process.stdout.write(`\n  SMS (console driver) to ${to}: ${body}\n\n`);
  }
}

class TwilioSmsTransport implements SmsTransport {
  async send(_to: string, _body: string): Promise<void> {
    throw new Error('Twilio transport not implemented yet — set SMS_DRIVER=console for now');
  }
}

export const sms: SmsTransport =
  env.SMS_DRIVER === 'console' ? new ConsoleSmsTransport() : new TwilioSmsTransport();

/** Warn loudly if a console driver is somehow live in production. */
if (env.NODE_ENV === 'production' && (env.MAIL_DRIVER === 'console' || env.SMS_DRIVER === 'console')) {
  logger.error('A console message transport is enabled in production — OTPs would be written to logs.');
}
