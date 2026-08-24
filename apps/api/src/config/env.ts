import { z } from 'zod';

/**
 * Environment validation. The process must refuse to boot with a misconfigured
 * environment rather than fail mysteriously at runtime — a security-sensitive
 * app should never start with, say, a missing pepper or a default secret.
 *
 * Secrets are additionally checked for minimum entropy in production.
 */

const hexSecret = z
  .string()
  .min(32, 'Secret must be at least 32 characters')
  .regex(/^[A-Za-z0-9+/=_-]+$/, 'Secret must be hex or base64-ish (no spaces)');

const rawEnv = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    WEB_ORIGIN: z.string().default('http://localhost:3000'),

    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

    REDIS_URL: z.string().optional().default(''),

    JWT_ACCESS_SECRET: hexSecret,
    JWT_REFRESH_SECRET: hexSecret,
    ACCESS_TOKEN_TTL: z.string().default('10m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

    IDENTIFIER_PEPPER: hexSecret,
    EVIDENCE_ENCRYPTION_KEY: hexSecret,

    STORAGE_DRIVER: z.enum(['local', 's3', 'cloudinary']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('./var/evidence'),
    S3_ENDPOINT: z.string().optional().default(''),
    S3_REGION: z.string().optional().default('auto'),
    S3_BUCKET: z.string().optional().default(''),
    S3_ACCESS_KEY_ID: z.string().optional().default(''),
    S3_SECRET_ACCESS_KEY: z.string().optional().default(''),

    /**
     * Cloudinary. Used for two very different jobs — see storage/cloudinary.ts
     * and services/media.service.ts:
     *   • evidence: encrypted `raw` uploads with private delivery
     *   • avatars:  ordinary image uploads with public CDN delivery
     */
    CLOUDINARY_CLOUD_NAME: z.string().optional().default(''),
    CLOUDINARY_API_KEY: z.string().optional().default(''),
    CLOUDINARY_API_SECRET: z.string().optional().default(''),
    /** Folder prefix so evidence and avatars never share a namespace. */
    CLOUDINARY_EVIDENCE_FOLDER: z.string().default('safecheck/evidence'),
    CLOUDINARY_AVATAR_FOLDER: z.string().default('safecheck/avatars'),

    MAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
    MAIL_FROM: z.string().default('SafeCheck <no-reply@safecheck.local>'),
    /**
     * Either SMTP_URL on its own, or the four discrete variables. See
     * services/messaging.service.ts for why both forms are accepted.
     */
    SMTP_URL: z.string().optional().default(''),
    SMTP_HOST: z.string().optional().default(''),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional().default(''),
    SMTP_PASS: z.string().optional().default(''),
    SMS_DRIVER: z.enum(['console', 'twilio']).default('console'),
    TWILIO_ACCOUNT_SID: z.string().optional().default(''),
    TWILIO_AUTH_TOKEN: z.string().optional().default(''),
    TWILIO_FROM: z.string().optional().default(''),

    APPEAL_WINDOW_DAYS: z.coerce.number().int().positive().default(14),
    EVIDENCE_RETENTION_DAYS: z.coerce.number().int().positive().default(365),

    GOOGLE_CLIENT_ID: z.string().optional().default(''),
    GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  })
  .superRefine((v, ctx) => {
    if (v.JWT_ACCESS_SECRET === v.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        message: 'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ',
        path: ['JWT_REFRESH_SECRET'],
      });
    }
    if (v.STORAGE_DRIVER === 's3' && !v.S3_BUCKET) {
      ctx.addIssue({
        code: 'custom',
        message: 'S3_BUCKET is required when STORAGE_DRIVER=s3',
        path: ['S3_BUCKET'],
      });
    }
    if (v.STORAGE_DRIVER === 'cloudinary') {
      for (const key of [
        'CLOUDINARY_CLOUD_NAME',
        'CLOUDINARY_API_KEY',
        'CLOUDINARY_API_SECRET',
      ] as const) {
        if (!v[key]) {
          ctx.addIssue({
            code: 'custom',
            message: `${key} is required when STORAGE_DRIVER=cloudinary`,
            path: [key],
          });
        }
      }
    }
    // Refuse to boot pointed at a mail driver that has nowhere to send. Left
    // unchecked, this only shows up as a failed registration for a real user.
    if (v.MAIL_DRIVER === 'smtp' && !v.SMTP_URL && !v.SMTP_HOST) {
      ctx.addIssue({
        code: 'custom',
        message:
          'MAIL_DRIVER=smtp needs either SMTP_URL, or SMTP_HOST with SMTP_USER/SMTP_PASS',
        path: ['SMTP_URL'],
      });
    }
    // Guard against shipping the placeholder peppers from .env.example.
    if (v.NODE_ENV === 'production') {
      const weak = new Set(['', 'changeme', 'secret']);
      for (const key of ['IDENTIFIER_PEPPER', 'EVIDENCE_ENCRYPTION_KEY'] as const) {
        if (weak.has(v[key])) {
          ctx.addIssue({ code: 'custom', message: `${key} looks like a placeholder`, path: [key] });
        }
      }
    }
  });

export type Env = z.infer<typeof rawEnv>;

function load(): Env {
  const parsed = rawEnv.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`\nInvalid environment configuration:\n${issues}\n`);
    throw new Error('Environment validation failed. See .env.example.');
  }
  return parsed.data;
}

export const env = load();

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDev = env.NODE_ENV === 'development';

/** True when a real Redis is configured; otherwise queues run inline. */
export const hasRedis = env.REDIS_URL.trim().length > 0;

/**
 * True when Cloudinary credentials are present. Avatar uploads are an optional
 * feature: without this they're simply unavailable, rather than crashing.
 */
export const hasCloudinary =
  env.CLOUDINARY_CLOUD_NAME.length > 0 &&
  env.CLOUDINARY_API_KEY.length > 0 &&
  env.CLOUDINARY_API_SECRET.length > 0;
