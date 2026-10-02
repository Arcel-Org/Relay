/**
 * In-memory rate limiter for API routes.
 *
 * Privacy posture:
 *  - The client IP is hashed with a process-lifetime salt BEFORE being used
 *    as a map key. A memory dump of this process yields SHA-256 digests, not
 *    raw IPs. The salt is regenerated every time the process starts, which
 *    means rate-limit state does not survive restarts (acceptable — this is
 *    ephemeral abuse control, not persistent accounting).
 *  - Entries are purged on window expiry and by the global retention sweeper.
 *  - Nothing about the request is written to disk or to any logger.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, createHmac } from 'crypto';
import { RETENTION, registerPurge, startRetentionSweeper } from '../privacy/data-retention';
import { isDevLikeEnv } from '../platform/env';
import { log } from '../platform/logger';

startRetentionSweeper();

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Process-lifetime salt. Regenerated on restart by design; rate-limit state
// is not meant to be persistent.
const IP_SALT = randomBytes(32);

function purgeStale() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.resetAt || now - entry.resetAt > RETENTION.RATE_LIMIT_WINDOW_MAX_MS) {
      store.delete(key);
    }
  }
}

registerPurge(purgeStale);

// Also run on a fast local cadence so expired windows free memory quickly,
// independent of the global sweeper.
if (typeof setInterval !== 'undefined') {
  setInterval(purgeStale, 60_000);
}

interface RateLimitOptions {
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Window size in milliseconds */
  windowMs: number;
}

const DEFAULT_OPTIONS: RateLimitOptions = {
  maxRequests: 10,
  windowMs: 60_000, // 1 minute
};

// D5/audit: cf-connecting-ip and x-real-ip are only trustworthy if the
// process genuinely cannot be reached except through Cloudflare/nginx — a
// header name alone proves nothing, since any direct request (e.g. the
// container's port published straight onto a public interface, as
// docker-compose.yml does by default) can set either header to anything.
// Trusting them unconditionally lets an attacker mint a fresh rate-limit
// bucket per request, defeating every IP-scoped limit in the app.
//
// Require an explicit operator opt-in once the deployment topology has
// actually been confirmed (origin firewalled to Cloudflare's ranges, or
// nginx is the only thing that can reach this process) — see
// docs/DEPLOY.md. Defaulting to untrusted is the safe choice: without it,
// every direct-connection client shares one 'direct' bucket, which is
// conservative but never spoofable.
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === 'true';

// Surface this loudly at startup outside dev/test — silently collapsing
// every direct client into one shared rate-limit bucket is easy to miss
// until abuse traffic shows up, and log.warn/debug are no-ops in
// production builds, so use log.error (always emitted) to make sure an
// operator actually sees this in their deployment logs.
if (!TRUST_PROXY_HEADERS && !isDevLikeEnv()) {
  log.error(
    '[rate-limit] TRUST_PROXY_HEADERS is not set to "true". All clients will share a single ' +
    'rate-limit bucket per endpoint unless this process is only reachable directly (no ' +
    'reverse proxy). If Cloudflare/nginx sits in front of this deployment, set ' +
    'TRUST_PROXY_HEADERS=true — see docs/DEPLOY.md.'
  );
}

/**
 * Extract the client IP from the request and return an opaque, salted hash.
 * The raw IP is not returned, retained, or logged.
 */
function getClientHandle(request: NextRequest): string {
  if (TRUST_PROXY_HEADERS) {
    // Cloudflare — highest precedence when present
    const cf = request.headers.get('cf-connecting-ip');
    if (cf) return createHmac('sha256', IP_SALT).update(cf.trim()).digest('hex');

    // nginx / trusted reverse-proxy
    const realIp = request.headers.get('x-real-ip');
    if (realIp) return createHmac('sha256', IP_SALT).update(realIp.trim()).digest('hex');
  }

  return createHmac('sha256', IP_SALT).update('direct').digest('hex');
}

// Short codes (lib/crypto/relay-id.ts's SHORT_CODE_REGEX: 4 letters + 4
// digits) are a small, fully-structured, exhaustively enumerable space
// (~4.57 billion combinations) — unlike usernames (unbounded freeform
// string space, needs a dictionary to guess) or the Relay ID (128 bits,
// computationally infeasible). A per-IP request-count limit alone doesn't
// stop a determined scanner: rotating IPs multiplies the budget linearly
// with no cost to the attacker, and every hit returns a full public
// profile. This miss-tracking limiter targets what scanning actually looks
// like — mostly-404 traffic — with a far stricter budget than the general
// per-route limit, while barely touching a legitimate caller who's mostly
// resolving codes they were actually given (which mostly hit).
const missStore = new Map<string, RateLimitEntry>();

/**
 * Check (without incrementing) whether this handle has already hit the miss
 * budget for `namespace`. Call BEFORE doing the lookup; call recordMiss()
 * after, only if the lookup was actually a miss.
 */
export function checkMissRateLimit(
  request: NextRequest,
  namespace: string,
  options: Partial<RateLimitOptions> = {}
): NextResponse | null {
  const { maxRequests, windowMs } = { ...DEFAULT_OPTIONS, ...options };
  const handle = getClientHandle(request);
  const key = `${namespace}:${handle}`;
  const now = Date.now();
  const entry = missStore.get(key);

  if (entry && now <= entry.resetAt && entry.count >= maxRequests) {
    // See checkRateLimit's identical log line above — handle is a salted
    // HMAC digest, not a raw IP. This is the enumeration-specific budget
    // (mostly-404 traffic), so a 429 here is a stronger scanning signal
    // than the general per-route limiter tripping.
    log.warn(`[RateLimit] 429 (miss) ${namespace} handle=${handle.slice(0, 16)} count=${entry.count}/${maxRequests}`);
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(retryAfterSec),
          'X-RateLimit-Limit': String(maxRequests),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil((entry.resetAt) / 1000)),
        },
      }
    );
  }

  void windowMs; // window is set on first recordMiss() call for this key, not here
  return null;
}

/** Record a miss for this handle/namespace — see checkMissRateLimit. */
export function recordMiss(request: NextRequest, namespace: string, windowMs: number): void {
  const handle = getClientHandle(request);
  const key = `${namespace}:${handle}`;
  const now = Date.now();
  let entry = missStore.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    missStore.set(key, entry);
  }
  entry.count += 1;
}

function purgeStaleMisses() {
  const now = Date.now();
  for (const [key, entry] of missStore) {
    if (now > entry.resetAt || now - entry.resetAt > RETENTION.RATE_LIMIT_WINDOW_MAX_MS) {
      missStore.delete(key);
    }
  }
}
registerPurge(purgeStaleMisses);
if (typeof setInterval !== 'undefined') {
  setInterval(purgeStaleMisses, 60_000);
}

/**
 * Check rate limit for a request. Returns null if allowed,
 * or a 429 NextResponse if the limit is exceeded.
 */
export function checkRateLimit(
  request: NextRequest,
  namespace: string,
  options: Partial<RateLimitOptions> = {}
): NextResponse | null {
  const { maxRequests, windowMs } = { ...DEFAULT_OPTIONS, ...options };
  const handle = getClientHandle(request);
  const key = `${namespace}:${handle}`;
  const now = Date.now();

  let entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    store.set(key, entry);
  }

  entry.count += 1;

  if (entry.count > maxRequests) {
    // handle is already a salted HMAC digest (see getClientHandle), not a
    // raw IP — logging it keeps the "nothing about the request is written
    // to a logger" privacy posture documented at the top of this file
    // intact, while still giving ops a forensic trail: without this, a
    // credential-stuffing/enumeration burst hitting the limit left zero
    // trace anywhere (a 429 return isn't a thrown error, so
    // withErrorHandler's catch-all logging never saw it either).
    log.warn(`[RateLimit] 429 ${namespace} handle=${handle.slice(0, 16)} count=${entry.count}/${maxRequests}`);
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(retryAfterSec),
          'X-RateLimit-Limit': String(maxRequests),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000)),
        },
      }
    );
  }

  return null;
}
