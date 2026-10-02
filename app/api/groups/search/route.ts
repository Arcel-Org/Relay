import { NextRequest, NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { getPublicGroupSearchCandidates } from '@/lib/db/public-groups-db';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { requireSession } from '@/lib/db/server-session';

// Flat cap on the candidate set fed into JS-side scoring/Levenshtein below —
// keeps per-request CPU cost constant as the group table grows.
const SEARCH_CANDIDATE_CAP = 500;

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  // D1: rate-limit Levenshtein search — 20 req/min per IP. Checked before
  // the session lookup — see groups/leave-directory's matching comment for
  // why (requireSession's DB read shouldn't be free for unauthenticated
  // traffic).
  const rateLimited = checkRateLimit(request, 'search:groups', { maxRequests: 20, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const qRaw = searchParams.get('q') || '';
  const limit = Math.max(1, Math.min(20, parseInt(searchParams.get('limit') || '10', 10) || 10));
  const q = qRaw.trim().toLowerCase().replace(/^@/, '');
  if (!q) return apiError('VALIDATION_ERROR', 'Missing q parameter', 400);
  if (q.length > 32) return apiError('VALIDATION_ERROR', 'Query too long', 400);

  const groups = await getPublicGroupSearchCandidates(q, SEARCH_CANDIDATE_CAP);

  const scored = groups.map((g) => {
    const handle = g.publicHandle.toLowerCase();
    const name = g.name.toLowerCase();
    let score = -1;
    let distance = 99;
    const check = (candidate: string) => {
      if (candidate === q) return { s: 0, d: 0 };
      if (candidate.startsWith(q)) return { s: 1, d: candidate.length - q.length };
      if (candidate.includes(q)) return { s: 2, d: candidate.length - q.length };
      const ld = levenshtein(candidate, q);
      if (ld <= 2) return { s: 3, d: ld };
      return null;
    };
    const h = check(handle);
    const n = check(name);
    const best = [h, n].filter(Boolean).sort((a, b) => a!.s - b!.s || a!.d - b!.d)[0];
    if (best) { score = best.s; distance = best.d; }
    return { score, distance, group: g };
  }).filter((s) => s.score >= 0);

  scored.sort((a, b) => a.score - b.score || a.distance - b.distance);

  // Strip pending lists — same projection as groups/join. Searchers should
  // not see who else has joined-pending or requested to join.
  return NextResponse.json(
    {
      results: scored.slice(0, limit).map((s) => ({
        groupId: s.group.groupId,
        publicHandle: s.group.publicHandle,
        name: s.group.name,
        description: s.group.description,
        avatarEmoji: s.group.avatarEmoji,
        avatarColor: s.group.avatarColor,
        memberCount: s.group.memberCount,
        joinPolicy: s.group.joinPolicy,
        ownerRelayId: s.group.ownerRelayId,
      })),
    },
    { status: 200 }
  );
});
