/**
 * Environment variable validation
 *
 * Validates required environment variables at server startup.
 * Import this from any server-side code to fail fast on misconfiguration.
 */

import { log } from '@/lib/platform/logger';

// Warn at startup (any import of this module, e.g. for isDevLikeEnv below,
// triggers this check) if the relay URL isn't configured. Consumers read
// process.env.NEXT_PUBLIC_RELAY_URL directly and apply their own fallback;
// this is a diagnostic, not a source of truth.
if (!process.env.NEXT_PUBLIC_RELAY_URL) {
  log.error(
    '\nMissing required environment variables:\n   - NEXT_PUBLIC_RELAY_URL\n' +
      '   Copy .env.example to .env.local and fill in the values.\n'
  );
}

// Environments where hardcoded dev-only secrets/fallbacks are permitted.
// Checking `NODE_ENV === 'production'` instead would silently hand out
// dev fallback values under 'staging', 'preview', or any other non-
// 'production' value a real deployment might use — defeating the secrets
// this check exists to protect. 'test' and unset are included because
// that's what local dev tooling and the test suite run under.
const DEV_LIKE_ENVS = new Set([undefined, 'development', 'test']);

/** True when running in local development or the test suite — the only environments allowed to use hardcoded fallback secrets. */
export function isDevLikeEnv(): boolean {
  return DEV_LIKE_ENVS.has(process.env.NODE_ENV);
}
