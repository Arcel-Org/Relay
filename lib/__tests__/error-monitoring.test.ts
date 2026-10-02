/**
 * Coverage for the opt-in-via-env-var contract of error-monitoring.ts: this
 * app's whole positioning is "no profile for anyone to subpoena" — wiring in
 * a third-party crash reporter must never change behavior for anyone who
 * hasn't explicitly opted in by setting SENTRY_DSN, and must never leak
 * cookies/headers/request bodies even when it IS configured.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sentryInit = vi.fn();
const sentryCaptureException = vi.fn();
vi.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => sentryInit(...args),
  captureException: (...args: unknown[]) => sentryCaptureException(...args),
  flush: vi.fn(async () => true),
}));

describe('error-monitoring: inert without SENTRY_DSN', () => {
  beforeEach(() => {
    vi.resetModules();
    sentryInit.mockClear();
    sentryCaptureException.mockClear();
    delete process.env.SENTRY_DSN;
  });

  it('initErrorMonitoring does not call Sentry.init when SENTRY_DSN is unset', async () => {
    const { initErrorMonitoring } = await import('../platform/error-monitoring');
    initErrorMonitoring();
    expect(sentryInit).not.toHaveBeenCalled();
  });

  it('captureException is a no-op when monitoring was never initialized', async () => {
    const { captureException } = await import('../platform/error-monitoring');
    expect(() => captureException(new Error('boom'))).not.toThrow();
    expect(sentryCaptureException).not.toHaveBeenCalled();
  });
});

describe('error-monitoring: opt-in behavior when SENTRY_DSN is set', () => {
  beforeEach(() => {
    vi.resetModules();
    sentryInit.mockClear();
    sentryCaptureException.mockClear();
    process.env.SENTRY_DSN = 'https://fake@example.ingest.sentry.io/1';
  });

  it('initializes Sentry with sendDefaultPii disabled and no tracing', async () => {
    const { initErrorMonitoring } = await import('../platform/error-monitoring');
    initErrorMonitoring();
    expect(sentryInit).toHaveBeenCalledWith(
      expect.objectContaining({ sendDefaultPii: false, tracesSampleRate: 0 })
    );
  });

  it('forwards captured exceptions to Sentry once initialized', async () => {
    const { initErrorMonitoring, captureException } = await import('../platform/error-monitoring');
    initErrorMonitoring();
    const err = new Error('real crash');
    captureException(err);
    expect(sentryCaptureException).toHaveBeenCalledWith(err);
  });

  it("beforeSend strips cookies/headers/request body before an event would be sent", async () => {
    const { initErrorMonitoring } = await import('../platform/error-monitoring');
    initErrorMonitoring();
    const beforeSend = sentryInit.mock.calls[0][0].beforeSend;
    const scrubbed = beforeSend({
      request: {
        cookies: { relay_session: 'super-secret-token' },
        headers: { authorization: 'Bearer secret' },
        data: { pin: '1234' },
        url: '/api/auth/login',
      },
    });
    expect(scrubbed.request.cookies).toBeUndefined();
    expect(scrubbed.request.headers).toBeUndefined();
    expect(scrubbed.request.data).toBeUndefined();
    expect(scrubbed.request.url).toBe('/api/auth/login');
  });
});
