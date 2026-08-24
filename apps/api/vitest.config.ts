import { defineConfig } from 'vitest/config';

/**
 * Test env is set here rather than in a .env.test file so the suite is
 * hermetic — it can never accidentally pick up development secrets or, worse,
 * point at the real Atlas cluster. MONGODB_URI is a placeholder: the setup
 * helper replaces it with an in-memory server's URI.
 */
const testEnv = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/safecheck-test-placeholder',
  JWT_ACCESS_SECRET: 'test_access_secret_0000000000000000000000000000000000',
  JWT_REFRESH_SECRET: 'test_refresh_secret_1111111111111111111111111111111111',
  IDENTIFIER_PEPPER: 'test_identifier_pepper_222222222222222222222222222222',
  EVIDENCE_ENCRYPTION_KEY: 'test_evidence_key_33333333333333333333333333333333',
  APPEAL_WINDOW_DAYS: '14',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: './var/evidence-test',
  MAIL_DRIVER: 'console',
  SMS_DRIVER: 'console',
};

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    env: testEnv,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
