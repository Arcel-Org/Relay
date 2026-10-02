/**
 * @vitest-environment node
 *
 * Direct coverage for lib/legal/canary-monitor.ts — the warrant-canary
 * staleness monitor. Previously zero test coverage despite being the only
 * thing standing between a missed canary re-confirmation and it silently
 * passing unnoticed (the whole point of a warrant canary depends on someone
 * actually noticing when it goes stale).
 *
 * node environment (not the project default jsdom): startCanaryMonitor's
 * browser no-op guard checks `typeof window !== 'undefined'`, and jsdom
 * always defines `window` — a node environment is required to exercise the
 * actual server-side started path at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db/canary-db', () => ({
  getCanaryStatus: vi.fn(),
  CANARY_CADENCE_DAYS: 90,
}));
vi.mock('@/lib/platform/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startCanaryMonitor', () => {
  it('runs an immediate freshness check on start, without waiting a full day', async () => {
    const { getCanaryStatus } = await import('@/lib/db/canary-db');
    vi.mocked(getCanaryStatus).mockResolvedValue({ overdue: false, confirmedAt: Date.now() } as any);
    const { startCanaryMonitor } = await import('../legal/canary-monitor');

    startCanaryMonitor();
    await vi.advanceTimersByTimeAsync(0);

    expect(getCanaryStatus).toHaveBeenCalledTimes(1);
  });

  it('logs a loud error when the canary is overdue', async () => {
    const { getCanaryStatus } = await import('@/lib/db/canary-db');
    const { log } = await import('@/lib/platform/logger');
    vi.mocked(getCanaryStatus).mockResolvedValue({ overdue: true, confirmedAt: Date.now() - 1000 } as any);
    const { startCanaryMonitor } = await import('../legal/canary-monitor');

    startCanaryMonitor();
    await vi.advanceTimersByTimeAsync(0);

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('OVERDUE'));
  });

  it('does not log an error when the canary is fresh', async () => {
    const { getCanaryStatus } = await import('@/lib/db/canary-db');
    const { log } = await import('@/lib/platform/logger');
    vi.mocked(getCanaryStatus).mockResolvedValue({ overdue: false, confirmedAt: Date.now() } as any);
    const { startCanaryMonitor } = await import('../legal/canary-monitor');

    startCanaryMonitor();
    await vi.advanceTimersByTimeAsync(0);

    expect(log.error).not.toHaveBeenCalled();
  });

  it('a DB failure is caught and logged, not thrown — must never crash the process', async () => {
    const { getCanaryStatus } = await import('@/lib/db/canary-db');
    const { log } = await import('@/lib/platform/logger');
    vi.mocked(getCanaryStatus).mockRejectedValue(new Error('db unavailable'));
    const { startCanaryMonitor } = await import('../legal/canary-monitor');

    expect(() => startCanaryMonitor()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('freshness check failed'),
      expect.any(Error)
    );
  });

  it('re-checks again after the daily interval elapses', async () => {
    const { getCanaryStatus } = await import('@/lib/db/canary-db');
    vi.mocked(getCanaryStatus).mockResolvedValue({ overdue: false, confirmedAt: Date.now() } as any);
    const { startCanaryMonitor } = await import('../legal/canary-monitor');

    startCanaryMonitor();
    await vi.advanceTimersByTimeAsync(0);
    expect(getCanaryStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(getCanaryStatus).toHaveBeenCalledTimes(2);
  });

  it('calling it a second time does not start a second interval (only one check per tick)', async () => {
    const { getCanaryStatus } = await import('@/lib/db/canary-db');
    vi.mocked(getCanaryStatus).mockResolvedValue({ overdue: false, confirmedAt: Date.now() } as any);
    const { startCanaryMonitor } = await import('../legal/canary-monitor');

    startCanaryMonitor();
    startCanaryMonitor();
    startCanaryMonitor();
    await vi.advanceTimersByTimeAsync(0);

    // If a second interval had been started, this would be 2 (or more) —
    // one extra immediate check per redundant start() call.
    expect(getCanaryStatus).toHaveBeenCalledTimes(1);
  });
});
