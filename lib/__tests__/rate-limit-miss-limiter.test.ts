/**
 * Direct coverage for lib/security/rate-limit.ts's miss-tracking limiter
 * (checkMissRateLimit/recordMiss) — the stricter, enumeration-scanning-
 * focused budget used by profile/lookup and auth/username-lookup for
 * short-code guesses (a small, fully enumerable space unlike usernames or
 * the Relay ID). rate-limit.test.ts and rate-limit-thresholds.test.ts only
 * ever exercise checkRateLimit (the general per-route limiter) — this file
 * covers the separate miss-only bucket and its check/record split.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/test', { headers });
}

beforeEach(() => {
  process.env.TRUST_PROXY_HEADERS = 'true';
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

afterEach(() => {
  delete process.env.TRUST_PROXY_HEADERS;
  vi.useRealTimers();
});

describe('checkMissRateLimit / recordMiss', () => {
  it('allows requests under the miss budget', async () => {
    const { checkMissRateLimit, recordMiss } = await import('../security/rate-limit');
    const req = makeRequest({ 'x-real-ip': '10.0.0.1' });

    for (let i = 0; i < 5; i++) {
      expect(checkMissRateLimit(req, 'ns:miss', { maxRequests: 5, windowMs: 60_000 })).toBeNull();
      recordMiss(req, 'ns:miss', 60_000);
    }
  });

  it('blocks once the miss budget is exhausted, with a 429 and rate-limit headers', async () => {
    const { checkMissRateLimit, recordMiss } = await import('../security/rate-limit');
    const req = makeRequest({ 'x-real-ip': '10.0.0.2' });

    for (let i = 0; i < 3; i++) {
      recordMiss(req, 'ns:miss', 60_000);
    }

    const result = checkMissRateLimit(req, 'ns:miss', { maxRequests: 3, windowMs: 60_000 });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    expect(result!.headers.get('Retry-After')).toBeTruthy();
    expect(result!.headers.get('X-RateLimit-Remaining')).toBe('0');
    const body = await result!.json();
    expect(body.error).toMatch(/too many/i);
  });

  it('checkMissRateLimit itself never increments the count — repeated checks with no recordMiss never trip the limit', async () => {
    const { checkMissRateLimit } = await import('../security/rate-limit');
    const req = makeRequest({ 'x-real-ip': '10.0.0.3' });

    for (let i = 0; i < 50; i++) {
      expect(checkMissRateLimit(req, 'ns:check-only', { maxRequests: 3, windowMs: 60_000 })).toBeNull();
    }
  });

  it('the window resets after windowMs — budget is available again', async () => {
    const { checkMissRateLimit, recordMiss } = await import('../security/rate-limit');
    const req = makeRequest({ 'x-real-ip': '10.0.0.4' });

    for (let i = 0; i < 2; i++) recordMiss(req, 'ns:window', 60_000);
    expect(checkMissRateLimit(req, 'ns:window', { maxRequests: 2, windowMs: 60_000 })).not.toBeNull();

    vi.setSystemTime(new Date('2026-01-01T00:01:01.000Z')); // past the 60s window
    expect(checkMissRateLimit(req, 'ns:window', { maxRequests: 2, windowMs: 60_000 })).toBeNull();
  });

  it('namespaces are isolated — a miss burst under one namespace does not affect another', async () => {
    const { checkMissRateLimit, recordMiss } = await import('../security/rate-limit');
    const req = makeRequest({ 'x-real-ip': '10.0.0.5' });

    for (let i = 0; i < 3; i++) recordMiss(req, 'ns:a', 60_000);
    expect(checkMissRateLimit(req, 'ns:a', { maxRequests: 3, windowMs: 60_000 })).not.toBeNull();
    expect(checkMissRateLimit(req, 'ns:b', { maxRequests: 3, windowMs: 60_000 })).toBeNull();
  });

  it('different clients get independent miss budgets', async () => {
    const { checkMissRateLimit, recordMiss } = await import('../security/rate-limit');
    const reqA = makeRequest({ 'x-real-ip': '10.0.0.6' });
    const reqB = makeRequest({ 'x-real-ip': '10.0.0.7' });

    for (let i = 0; i < 3; i++) recordMiss(reqA, 'ns:clients', 60_000);
    expect(checkMissRateLimit(reqA, 'ns:clients', { maxRequests: 3, windowMs: 60_000 })).not.toBeNull();
    expect(checkMissRateLimit(reqB, 'ns:clients', { maxRequests: 3, windowMs: 60_000 })).toBeNull();
  });

  it('the miss bucket is independent of the general checkRateLimit bucket — hitting one does not exhaust the other', async () => {
    const { checkRateLimit, checkMissRateLimit, recordMiss } = await import('../security/rate-limit');
    const req = makeRequest({ 'x-real-ip': '10.0.0.8' });

    // Exhaust the general limiter for this same namespace string.
    for (let i = 0; i < 3; i++) checkRateLimit(req, 'shared:namespace', { maxRequests: 3, windowMs: 60_000 });
    expect(checkRateLimit(req, 'shared:namespace', { maxRequests: 3, windowMs: 60_000 })).not.toBeNull();

    // The miss limiter under the SAME namespace string is untouched — a
    // fresh handle+namespace pair with zero recordMiss calls yet.
    expect(checkMissRateLimit(req, 'shared:namespace', { maxRequests: 3, windowMs: 60_000 })).toBeNull();
    for (let i = 0; i < 3; i++) recordMiss(req, 'shared:namespace', 60_000);
    expect(checkMissRateLimit(req, 'shared:namespace', { maxRequests: 3, windowMs: 60_000 })).not.toBeNull();
  });
});
