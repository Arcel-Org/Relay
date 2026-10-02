/**
 * Optional, opt-in server-side crash reporting via Sentry (or any
 * Sentry-protocol-compatible self-hosted alternative, e.g. GlitchTip — just
 * point SENTRY_DSN at it).
 *
 * Deliberately scoped to SERVER-SIDE errors only (Next.js API routes' node
 * runtime, and the standalone WS relay process) — never the browser client.
 * This is a zero-knowledge, no-account messenger; end users' browsers must
 * never phone home to a third party. This module only ever runs in Node
 * processes the OPERATOR controls, reporting the operator's own server
 * exceptions — not user data, message content, or client-side errors.
 *
 * Completely inert unless SENTRY_DSN is set, matching the same
 * opt-in-via-env-var pattern as browser notifications — zero behavior
 * change for anyone who doesn't configure it.
 */
import * as Sentry from '@sentry/node';
import { log } from '@/lib/platform/logger';

let initialized = false;

/**
 * Strip anything that could carry secrets before a report leaves this
 * process — session cookies/tokens, auth headers, and request bodies (API
 * payloads here can include PIN-derived material, encrypted key blobs, or
 * recovery codes; even though they're not plaintext-sensitive on their own,
 * none of it belongs on a third-party service). Only the exception itself
 * (type, message, stack trace) and non-sensitive request metadata (method,
 * URL path) are kept.
 */
function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.data;
  }
  return event;
}

/** Call once at process boot (Next.js instrumentation.ts / relay-node.ts entrypoint). */
export function initErrorMonitoring(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    // Never send IP addresses, cookies, or headers by default — this is the
    // SDK default already, set explicitly so it can't silently change under us.
    sendDefaultPii: false,
    beforeSend: (event) => scrubEvent(event),
    // Error reporting only — no performance/tracing payloads to review or scrub.
    tracesSampleRate: 0,
  });
  initialized = true;
  log.debug('[error-monitoring] Sentry initialized');
}

/** Report an exception. No-op if SENTRY_DSN was never configured. */
export function captureException(err: unknown): void {
  if (!initialized) return;
  try {
    Sentry.captureException(err);
  } catch {
    /* reporting itself must never throw into the caller's error path */
  }
}
