/**
 * Locks in the rate-limit thresholds actually wired up across API routes,
 * by reading the source of each route file and asserting the maxRequests
 * value passed to checkRateLimit(). This does NOT re-test rate-limit.ts's
 * mechanism (see rate-limit.test.ts for that) — it exists purely so that a
 * future change to any of these thresholds shows up as a deliberate, visible
 * diff in this file rather than a silent regression buried in a route file.
 *
 * If a route's threshold changes intentionally, update the expected value
 * here in the same commit.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

function extractMaxRequests(routeRelativePath: string, namespace: string): number {
  const src = readFileSync(join(process.cwd(), routeRelativePath), 'utf8');
  const re = new RegExp(
    `checkRateLimit\\([^)]*['"]${namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"][^)]*maxRequests:\\s*(\\d+)`,
    's'
  );
  const match = src.match(re);
  if (!match) {
    throw new Error(`Could not find checkRateLimit(..., '${namespace}', { maxRequests: N }) in ${routeRelativePath}`);
  }
  return Number(match[1]);
}

describe('rate limit thresholds (documented, current values)', () => {
  const cases: Array<{ route: string; namespace: string; expected: number }> = [
    { route: 'app/api/auth/login/route.ts', namespace: 'auth:login', expected: 15 },
    { route: 'app/api/auth/signup/route.ts', namespace: 'auth:signup', expected: 3 },
    { route: 'app/api/auth/recovery-login/route.ts', namespace: 'auth:recovery-login', expected: 3 },
    { route: 'app/api/auth/regenerate-recovery-code/route.ts', namespace: 'auth:regen-recovery', expected: 3 },
    { route: 'app/api/auth/username-lookup/route.ts', namespace: 'auth:username-lookup', expected: 20 },
    { route: 'app/api/auth/ws-ticket/route.ts', namespace: 'auth:ws-ticket', expected: 30 },
    { route: 'app/api/profile/search/route.ts', namespace: 'search:profile', expected: 20 },
    { route: 'app/api/profile/lookup/route.ts', namespace: 'profile:lookup', expected: 30 },
    { route: 'app/api/groups/join/route.ts', namespace: 'groups:join', expected: 10 },
    { route: 'app/api/groups/search/route.ts', namespace: 'search:groups', expected: 20 },
    { route: 'app/api/groups/directory/route.ts', namespace: 'groups:create', expected: 5 },
    { route: 'app/api/groups/directory/route.ts', namespace: 'groups:handle-check', expected: 20 },
  ];

  for (const { route, namespace, expected } of cases) {
    it(`${route} (${namespace}) allows ${expected} requests/min`, () => {
      expect(extractMaxRequests(route, namespace)).toBe(expected);
    });
  }
});
