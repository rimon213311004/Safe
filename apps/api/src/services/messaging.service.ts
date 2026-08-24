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
 *
 * MAIL_DRIVER=brevo exists for one reason: SMTP assumes you are allowed to open
 * a socket to a mail port, and on free hosting tiers you are not. See
 * BrevoApiMailTransport.
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
 * Fail fast on a relay that never answers.
 *
 * Nodemailer waits two minutes to connect by default, which is longer than any
 * caller is prepared to wait: the browser gives up first and the registration
 * that triggered the send is left with no answer at all, while the request keeps
 * a worker busy on a small instance. The usual cause is not a slow relay but a
 * silently dropped packet — most free hosting tiers block outbound 25/465/587 to
 * keep spammers off, and a blocked port looks exactly like a host that is simply
 * not listening. Ten seconds is generous for a TCP handshake and a greeting
 * anywhere in the world; past that, something is wrong, and the log line saying
 * so is worth more than another 110 seconds of waiting.
 */
const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
} as const;

/**
 * Two ways to point this at a provider, both handled here:
 *
 *   SMTP_URL=smtps://user:pass@smtp.example.com:465
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
 *
 * The discrete variables exist because a URL has to percent-encode its
 * password, and a pasted password containing `@` or `/` produces an
 * authentication failure that looks nothing like an encoding bug. If both are
 * present the URL wins — nodemailer parses `url` and lets its fields override
 * the rest, which is why the timeouts above can sit alongside it.
 */
function smtpConnection() {
  const url = env.SMTP_URL.trim();
  if (url) return { url, ...SMTP_TIMEOUTS };
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 is implicit TLS; 587 and 2525 open in the clear and upgrade via
    // STARTTLS, which nodemailer does on its own when `secure` is false.
    secure: env.SMTP_PORT === 465,
    // Spread rather than `auth: undefined` — an unauthenticated relay (a local
    // Mailpit, say) must not send an empty AUTH command.
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}),
    ...SMTP_TIMEOUTS,
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
 * `SafeCheck <no-reply@example.com>` → `{ name, email }`.
 *
 * SMTP takes that header verbatim; a JSON API wants the two parts separately.
 * A bare address with no display name is valid and stays nameless.
 */
function parseMailFrom(from: string): { name?: string; email: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!match) return { email: from.trim() };
  const name = match[1]!.replace(/^"|"$/g, '').trim();
  return name ? { name, email: match[2]!.trim() } : { email: match[2]!.trim() };
}

/**
 * Send over HTTPS instead of SMTP.
 *
 * Every free hosting tier worth deploying to — Render's included — blocks
 * outbound connections to the mail submission ports. Not just 25, which would be
 * ordinary anti-spam hygiene, but 465, 587 and 2525 as well: all three time out
 * from a free Render instance while a connection to MongoDB Atlas on 27017 from
 * the same container succeeds. The filter is on the ports, not on egress, so no
 * amount of choosing a different relay or a different port helps. The way out is
 * to stop speaking SMTP and post the message to a provider's REST API over 443,
 * which is a port nobody blocks.
 *
 * Brevo is the provider here only because its free tier sends 300 messages a day
 * without a card. Nothing about the interface is Brevo-shaped; another provider
 * is another class of this size.
 *
 * BREVO_API_KEY must be a v3 key (`xkeysib-…`) from Brevo's SMTP & API →
 * API keys page. The `xsmtpsib-…` value on the SMTP tab is an SMTP password and
 * this endpoint rejects it with 401 — an easy hour to lose, since both are
 * labelled "key" in the dashboard.
 */
class BrevoApiMailTransport implements MailTransport {
  static readonly #ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

  async send(message: OutboundMessage): Promise<void> {
    let response: Response;
    try {
      response = await fetch(BrevoApiMailTransport.#ENDPOINT, {
        method: 'POST',
        headers: {
          'api-key': env.BREVO_API_KEY,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender: parseMailFrom(env.MAIL_FROM),
          to: [{ email: message.to }],
          subject: message.subject,
          textContent: message.body,
        }),
        // Same reasoning as SMTP_TIMEOUTS: a caller is waiting on this, and
        // fetch has no timeout of its own.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      logger.error({ err: cause }, 'Brevo API request failed');
      throw new Error('Could not send the verification email. Try again shortly.', { cause });
    }

    if (!response.ok) {
      // Brevo answers errors as `{code, message}`. Worth logging in full: it
      // names the actual problem — an unrecognised key, an unverified sender,
      // the daily quota — where the status alone would not.
      const detail = await response.text().catch(() => '');
      logger.error({ status: response.status, detail }, 'Brevo rejected the message');
      throw new Error('Could not send the verification email. Try again shortly.');
    }

    // No recipient in the log line, for the same reason as the SMTP transport.
    const receipt = (await response.json().catch(() => ({}))) as { messageId?: string };
    logger.info({ messageId: receipt.messageId }, 'Mail accepted by Brevo');
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
    : env.MAIL_DRIVER === 'brevo'
      ? new BrevoApiMailTransport()
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
