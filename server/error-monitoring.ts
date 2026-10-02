/**
 * Optional, opt-in crash reporting for the standalone WS relay process via
 * Sentry (or any Sentry-protocol-compatible self-hosted alternative, e.g.
 * GlitchTip — just point SENTRY_DSN at it).
 *
 * Twin of lib/platform/error-monitoring.ts (the Next.js API-route side) —
 * kept as a separate, relative-imports-only file rather than shared code
 * because this process runs under plain ts-node with no path-alias
 * resolution (see relay-node.ts's SESSION_SECRET comment for the same
 * constraint). Inert unless SENTRY_DSN is set — zero behavior change
 * otherwise.
 */
import * as Sentry from '@sentry/node';
import { log } from './logger';

let initialized = false;

/** Strip anything that could carry secrets — see the Next.js twin for why. */
function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.data;
  }
  return event;
}

export function initErrorMonitoring(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    sendDefaultPii: false,
    beforeSend: (event) => scrubEvent(event),
    tracesSampleRate: 0,
  });
  initialized = true;
  log.debug('[error-monitoring] Sentry initialized (relay server)');
}

export function captureException(err: unknown): void {
  if (!initialized) return;
  try {
    Sentry.captureException(err);
  } catch {
    /* reporting itself must never throw */
  }
}

/**
 * Sentry.captureException only queues the event — actually delivering it is
 * async. Call this (and await it) before process.exit() on an uncaught
 * exception, or the report never leaves the process. No-op (resolves
 * immediately) if monitoring was never initialized.
 */
export async function flushErrorMonitoring(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    /* best-effort — must never block/prevent the exit it's guarding */
  }
}
