import { NextRequest, NextResponse } from 'next/server';
import { getUsernameSearchCandidates } from '@/lib/db/relay-server-db';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { requireSession } from '@/lib/db/server-session';

// Flat cap on the candidate set fed into JS-side scoring/Levenshtein below —
// keeps per-request CPU cost constant as the user table grows, instead of
// scanning + fuzzy-matching every row (see getUsernameSearchCandidates).
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
  const rateLimited = checkRateLimit(request, 'search:profile', { maxRequests: 20, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireSession(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const qRaw = searchParams.get('q') || '';
  const limitRaw = searchParams.get('limit');
  const limit = Math.max(1, Math.min(20, parseInt(limitRaw || '4', 10) || 4));
  const requesterRelayId = auth.relayId;

  const q = qRaw.trim().toLowerCase().replace(/^@/, '');
  if (!q) {
    return apiError('VALIDATION_ERROR', 'Missing q parameter', 400);
  }
  if (q.length > 32) {
    return apiError('VALIDATION_ERROR', 'Query too long', 400);
  }

  const users = await getUsernameSearchCandidates(q, requesterRelayId, SEARCH_CANDIDATE_CAP);

  type Scored = {
    score: number;
    distance: number;
    user: {
      username: string;
      relayId: string;
      displayName?: string;
      avatarEmoji?: string;
      avatarColor?: string;
    };
  };

  const scored: Scored[] = [];
  for (const u of users) {
    if (!u.username) continue;
    if (u.isUnlisted === true) continue;
    if (requesterRelayId && u.relayId === requesterRelayId) continue;
    const uname = u.username.toLowerCase();
    let score = -1;
    let distance = 99;
    if (uname === q) {
      score = 0;
      distance = 0;
    } else if (uname.startsWith(q)) {
      score = 1;
      distance = uname.length - q.length;
    } else if (uname.includes(q)) {
      score = 2;
      distance = uname.length - q.length;
    } else {
      const d = levenshtein(uname, q);
      if (d <= 2) {
        score = 3;
        distance = d;
      }
    }
    if (score >= 0) {
      scored.push({
        score,
        distance,
        user: {
          username: u.username,
          relayId: u.relayId,
          displayName: u.displayName,
          avatarEmoji: u.avatarEmoji,
          avatarColor: u.avatarColor,
        },
      });
    }
  }

  scored.sort((a, b) => a.score - b.score || a.distance - b.distance || a.user.username.localeCompare(b.user.username));

  return NextResponse.json(
    { results: scored.slice(0, limit).map((s) => s.user) },
    { status: 200 }
  );
});
