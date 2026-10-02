/**
 * Conditional logger — suppresses verbose debug output in production
 * builds. log.warn and log.error are never suppressed, so never pass
 * secrets, keys, tokens, or PINs to either — those args reach the
 * production console as-is.
 * Import and use instead of console.log/warn/error for debug output.
 *
 *   import { log } from '@/lib/platform/logger';
 *   log.debug('[WS]', 'Connected');
 *   log.warn('[Crypto]', 'Key rotation triggered');
 *   log.error('[Auth]', 'Login failed', err);
 *
 * log.warn used to be dev-only too, silently dropping every call in
 * production — including the rate-limiter's 429 forensic trail and the
 * admin dashboard's ban audit line ("Account banned: X by Y"), which meant
 * there was no record of who banned whom on any real deployment. A warning
 * is, by definition, meant to be seen; debug output is the only tier that
 * should be suppressible.
 */

const isDev =
  typeof process !== 'undefined' && process.env.NODE_ENV === 'development';

function noop(..._args: unknown[]) {}

export const log = {
  /** Verbose debug output — only in development */
  debug: isDev ? console.log.bind(console) : noop,
  /** Warnings — always logged (these indicate real operational signals) */
  warn: console.warn.bind(console),
  /** Errors — always logged (these indicate real problems) */
  error: console.error.bind(console),
};
