/**
 * log.warn used to be gated the same as log.debug (dev-only), silently
 * dropping every call in production — including the rate-limiter's 429
 * forensic trail and the admin dashboard's ban audit line. Only log.debug
 * should be suppressible; warn and error are meant to be real operational
 * signals, always emitted regardless of NODE_ENV.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined) {
  (process.env as { NODE_ENV: string | undefined }).NODE_ENV = value;
}

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV);
  vi.restoreAllMocks();
});

describe('log — production (NODE_ENV=production)', () => {
  beforeEach(() => {
    setNodeEnv('production');
    vi.resetModules();
  });

  it('log.debug is a no-op', async () => {
    const spy = vi.spyOn(console, 'log');
    const { log } = await import('../platform/logger');
    log.debug('should not print');
    expect(spy).not.toHaveBeenCalled();
  });

  it('log.warn IS emitted (the actual regression)', async () => {
    const spy = vi.spyOn(console, 'warn');
    const { log } = await import('../platform/logger');
    log.warn('[Admin] Account banned:', 'relay:someone', 'by', 'relay:admin');
    expect(spy).toHaveBeenCalledWith('[Admin] Account banned:', 'relay:someone', 'by', 'relay:admin');
  });

  it('log.error is emitted', async () => {
    const spy = vi.spyOn(console, 'error');
    const { log } = await import('../platform/logger');
    log.error('boom');
    expect(spy).toHaveBeenCalledWith('boom');
  });
});

describe('log — development (NODE_ENV=development)', () => {
  beforeEach(() => {
    setNodeEnv('development');
    vi.resetModules();
  });

  it('log.debug is emitted', async () => {
    const spy = vi.spyOn(console, 'log');
    const { log } = await import('../platform/logger');
    log.debug('visible in dev');
    expect(spy).toHaveBeenCalledWith('visible in dev');
  });

  it('log.warn is emitted', async () => {
    const spy = vi.spyOn(console, 'warn');
    const { log } = await import('../platform/logger');
    log.warn('visible in dev too');
    expect(spy).toHaveBeenCalledWith('visible in dev too');
  });
});
