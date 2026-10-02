/**
 * Tests for lib/rate-limit.ts
 *
 * Covers:
 *  - Token-bucket/window semantics: N requests allowed, N+1th blocked,
 *    window reset re-allows requests.
 *  - Namespace isolation (one route's limit doesn't bleed into another's).
 *  - Client-handle precedence: cf-connecting-ip > x-real-ip > 'direct'
 *    (bare X-Forwarded-For is never trusted on its own).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/test', { headers });
}

describe('checkRateLimit — window/token-bucket behavior', () => {
  beforeEach(() => {
    // These tests distinguish clients by x-real-ip, which is only trusted
    // once TRUST_PROXY_HEADERS is set (see 'client IP precedence / trust'
    // below for the untrusted-by-default behavior itself).
    process.env.TRUST_PROXY_HEADERS = 'true';
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    delete process.env.TRUST_PROXY_HEADERS;
    vi.useRealTimers();
  });

  it('allows exactly maxRequests requests then blocks the next one within the window', async () => {
    const { checkRateLimit } = await import('../security/rate-limit');
    const req = makeRequest({ 'x-real-ip': '10.0.0.1' });

    for (let i = 0; i < 3; i++) {
      const result = checkRateLimit(req, 'test:bucket-a', { maxRequests: 3, windowMs: 60_000 });
      expect(result).toBeNull();
    }

    const blocked = checkRateLimit(req, 'test:bucket-a', { maxRequests: 3, windowMs: 60_000 });
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
  });

  it('sets Retry-After / X-RateLimit-* headers on the 429 response', async () => {
    const { checkRateLimit } = await import('../security/rate-limit');
    const req = makeRequest({ 'x-real-ip': '10.0.0.2' });

    checkRateLimit(req, 'test:bucket-headers', { maxRequests: 1, windowMs: 30_000 });
    const blocked = checkRateLimit(req, 'test:bucket-headers', { maxRequests: 1, windowMs: 30_000 });

    expect(blocked).not.toBeNull();
    expect(blocked!.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(blocked!.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(Number(blocked!.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(blocked!.headers.get('Retry-After'))).toBeLessThanOrEqual(30);
  });

  it('allows requests again after the window resets', async () => {
    const { checkRateLimit } = await import('../security/rate-limit');
    const req = makeRequest({ 'x-real-ip': '10.0.0.3' });

    checkRateLimit(req, 'test:bucket-reset', { maxRequests: 1, windowMs: 10_000 });
    const blockedWithinWindow = checkRateLimit(req, 'test:bucket-reset', { maxRequests: 1, windowMs: 10_000 });
    expect(blockedWithinWindow).not.toBeNull();

    // Advance past the window.
    vi.setSystemTime(new Date('2026-01-01T00:00:11.000Z'));

    const allowedAfterReset = checkRateLimit(req, 'test:bucket-reset', { maxRequests: 1, windowMs: 10_000 });
    expect(allowedAfterReset).toBeNull();
  });

  it('does not let requests in one namespace consume another namespace\'s budget', async () => {
    const { checkRateLimit } = await import('../security/rate-limit');
    const req = makeRequest({ 'x-real-ip': '10.0.0.4' });

    // Exhaust namespace A.
    checkRateLimit(req, 'ns:a', { maxRequests: 1, windowMs: 60_000 });
    const blockedA = checkRateLimit(req, 'ns:a', { maxRequests: 1, windowMs: 60_000 });
    expect(blockedA).not.toBeNull();

    // Namespace B for the same client should be untouched.
    const allowedB = checkRateLimit(req, 'ns:b', { maxRequests: 1, windowMs: 60_000 });
    expect(allowedB).toBeNull();
  });

  it('tracks separate clients (different handles) independently', async () => {
    const { checkRateLimit } = await import('../security/rate-limit');
    const reqA = makeRequest({ 'x-real-ip': '10.0.0.5' });
    const reqB = makeRequest({ 'x-real-ip': '10.0.0.6' });

    checkRateLimit(reqA, 'ns:shared', { maxRequests: 1, windowMs: 60_000 });
    const blockedA = checkRateLimit(reqA, 'ns:shared', { maxRequests: 1, windowMs: 60_000 });
    expect(blockedA).not.toBeNull();

    // A different client's own first request must still be allowed.
    const allowedB = checkRateLimit(reqB, 'ns:shared', { maxRequests: 1, windowMs: 60_000 });
    expect(allowedB).toBeNull();
  });
});

describe('checkRateLimit — client IP precedence / trust', () => {
  beforeEach(() => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.TRUST_PROXY_HEADERS;
  });

  it('ignores cf-connecting-ip / x-real-ip entirely unless TRUST_PROXY_HEADERS=true', async () => {
    delete process.env.TRUST_PROXY_HEADERS;
    vi.resetModules();
    const { checkRateLimit } = await import('../security/rate-limit');

    // Two different real IPs via a trusted-proxy-style header, but the
    // trust flag is unset — both must land in the shared 'direct' bucket.
    const reqA = makeRequest({ 'cf-connecting-ip': '1.2.3.4' });
    const reqB = makeRequest({ 'cf-connecting-ip': '5.6.7.8' });

    checkRateLimit(reqA, 'ns:trust-flag-off', { maxRequests: 1, windowMs: 60_000 });
    const blocked = checkRateLimit(reqB, 'ns:trust-flag-off', { maxRequests: 1, windowMs: 60_000 });
    expect(blocked).not.toBeNull();
  });

  it('prefers cf-connecting-ip over x-real-ip and x-forwarded-for', async () => {
    const { checkRateLimit } = await import('../security/rate-limit');

    const reqCf = makeRequest({
      'cf-connecting-ip': '1.1.1.1',
      'x-real-ip': '2.2.2.2',
      'x-forwarded-for': '3.3.3.3',
    });
    const reqCfSameValue = makeRequest({
      'cf-connecting-ip': '1.1.1.1',
      'x-real-ip': '9.9.9.9', // different trusted-proxy header, must not matter
      'x-forwarded-for': '8.8.8.8',
    });

    // Same cf-connecting-ip => same bucket, regardless of other headers.
    checkRateLimit(reqCf, 'ns:cf-precedence', { maxRequests: 1, windowMs: 60_000 });
    const blocked = checkRateLimit(reqCfSameValue, 'ns:cf-precedence', { maxRequests: 1, windowMs: 60_000 });
    expect(blocked).not.toBeNull();
  });

  it('falls back to x-real-ip when cf-connecting-ip is absent', async () => {
    const { checkRateLimit } = await import('../security/rate-limit');

    const req1 = makeRequest({ 'x-real-ip': '5.5.5.5', 'x-forwarded-for': '6.6.6.6' });
    const req2 = makeRequest({ 'x-real-ip': '5.5.5.5', 'x-forwarded-for': '7.7.7.7' });

    checkRateLimit(req1, 'ns:realip-precedence', { maxRequests: 1, windowMs: 60_000 });
    const blocked = checkRateLimit(req2, 'ns:realip-precedence', { maxRequests: 1, windowMs: 60_000 });
    expect(blocked).not.toBeNull();
  });

  it('never trusts a bare X-Forwarded-For with no trusted-proxy header present', async () => {
    const { checkRateLimit } = await import('../security/rate-limit');

    // Two different "clients" that only differ by a spoofable XFF header,
    // and no cf-connecting-ip/x-real-ip from a real proxy, must land in the
    // same bucket ('direct') rather than being treated as distinct clients.
    const reqA = makeRequest({ 'x-forwarded-for': '11.11.11.11' });
    const reqB = makeRequest({ 'x-forwarded-for': '22.22.22.22' });

    checkRateLimit(reqA, 'ns:xff-untrusted', { maxRequests: 1, windowMs: 60_000 });
    const blocked = checkRateLimit(reqB, 'ns:xff-untrusted', { maxRequests: 1, windowMs: 60_000 });
    expect(blocked).not.toBeNull();
  });
});
