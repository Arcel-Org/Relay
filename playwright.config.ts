import { defineConfig, devices } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * Runs e2e against a real production build (`next build` + compiled relay)
 * served over self-signed HTTPS, instead of `next dev`. `next dev`'s
 * on-demand per-route compilation was the root cause of a recurring 60s
 * timeout waiting for the signup PIN keypad (confirmed by reproducing the
 * identical failure against a pre-session commit in a scratch worktree) —
 * production mode has no JIT compile latency to race against the test
 * timeout. HTTPS (not plain HTTP) is required, not just closer to real
 * deployment: lib/db/server-session.ts forces the session cookie's `secure`
 * flag on whenever NODE_ENV=production, with no scheme-detection fallback,
 * so a prod-mode server over plain http silently can't persist the login
 * cookie at all. Reuses the exact self-signed-cert mechanism server.js
 * already supports for LAN dev (see docs/DEPLOY.md §3), pointed at a
 * dedicated cert dir via TLS_CERT_DIR so this never touches a developer's
 * own dev-certs/.
 */

const CERT_DIR = path.join(__dirname, 'e2e-certs');
const DATA_DIR = path.join(__dirname, '.e2e-data');
const APP_PORT = 3020;
const RELAY_PORT = 8090;
const BASE_URL = `https://localhost:${APP_PORT}`;

if (!fs.existsSync(path.join(CERT_DIR, 'key.pem'))) {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${CERT_DIR}/key.pem" -out "${CERT_DIR}/cert.pem" -days 365 -nodes -subj '/CN=localhost'`,
    { stdio: 'inherit' }
  );
}

// Fresh per test-run data dir — avoids colliding with real dev data (.data/)
// or leftover accounts/sessions from a previous e2e run.
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const sharedEnv: Record<string, string> = {
  NODE_ENV: 'production',
  TLS_CERT_DIR: CERT_DIR,
  SESSION_STORE_DIR: DATA_DIR,
  DATA_DIR: DATA_DIR,
  // Fixed, clearly-fake secrets — this process only ever touches the
  // throwaway DATA_DIR above, never real user data.
  SESSION_SECRET: 'e2e-test-only-session-secret-not-for-real-deployments-00',
  TOTP_ENCRYPTION_KEY: '00'.repeat(32),
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_ORIGIN: BASE_URL,
  WS_ALLOWED_ORIGINS: BASE_URL,
  // Each test simulates an independent real-world user and sets its own
  // X-Real-IP (see tests/e2e/helpers.ts) so signup's 3-per-minute rate
  // limit (app/api/auth/signup/route.ts) doesn't bucket every test in the
  // suite together — without this, only the first ~3 signups in any given
  // run succeed and the rest get silently 429'd, since lib/security/rate-limit.ts
  // buckets all direct-connection clients as one 'direct' client unless a
  // trusted proxy header is present.
  TRUST_PROXY_HEADERS: 'true',
  NEXT_PUBLIC_RELAY_URL: `wss://localhost:${APP_PORT}`,
  RELAY_PORT: String(RELAY_PORT),
  PORT: String(APP_PORT),
  COVER_TRAFFIC_ENABLED: 'false', // deterministic message timing for assertions
};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'node dist-server/server/relay-node.js',
      port: RELAY_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
      env: sharedEnv,
    },
    {
      command: 'node server.js',
      url: `${BASE_URL}/api/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 60_000,
      env: sharedEnv,
    },
  ],
});
