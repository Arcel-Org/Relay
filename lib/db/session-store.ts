/**
 * Server-side session store
 *
 * Sessions are opaque, high-entropy random tokens (32 bytes from
 * crypto.randomBytes, base64url-encoded) minted at login/signup time.
 * Only a SHA-256 hash of the token is ever persisted — the raw token is
 * returned once, to be set as the HttpOnly cookie value, and is never
 * written to disk.
 *
 * This is deliberately NOT a signature over public data (relayId +
 * timestamp) the way the old scheme was. Verifying a session now
 * requires an indexed lookup against tokens that were actually issued,
 * so knowing SESSION_SECRET (or any other global secret) is no longer
 * sufficient to forge a session for an arbitrary — or even an
 * existing — relayId. Forging a session requires either guessing a
 * 256-bit random token or compromising the session store itself.
 *
 * Storage: a JSON file under DATA_DIR (matches the pattern used by
 * lib/db/relay-server-db.ts), with an in-memory index kept as the
 * source of truth for reads. Verification (the hot path — it runs on
 * every authenticated request) is therefore a plain Map lookup with no
 * disk I/O; disk writes only happen on session creation/revocation.
 */

import fs from 'fs/promises';
import path from 'path';
import { randomBytes, createHash } from 'crypto';
import { log } from '../platform/logger';

export interface SessionRecord {
  tokenHash: string; // sha256 hex digest of the opaque token
  relayId: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  // Last time this session was used (login, HTTP request, or WS message).
  // Backs server-side inactivity-timeout enforcement — see
  // isIdleExpired/touchSessionActivity below.
  lastActivityAt: number;
  // User-configured idle threshold for THIS session, mirroring the
  // client-side auto-logout setting (lib/auth/auto-logout.ts). null means
  // no server-side idle enforcement (matches the client default of "Off").
  // Synced from the client via app/api/auth/session-settings/route.ts.
  inactivityTimeoutMs: number | null;
}

// Overridable so tests (and alternate deployments) can point the store at
// an isolated directory instead of the real `.data` used by the app.
const DATA_DIR = process.env.SESSION_STORE_DIR || path.join(process.cwd(), '.data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSIONS_TMP = SESSIONS_FILE + '.tmp';

export const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory index: tokenHash -> record. This is the source of truth for
// verification reads; it is persisted to disk on every mutation so
// sessions survive process restarts.
const index = new Map<string, SessionRecord>();
let loaded = false;
let loadPromise: Promise<void> | null = null;

// Secondary index: relayId -> Set<tokenHash>, so revokeAllSessions doesn't
// have to scan every session in the process (O(total_sessions)) to find the
// handful belonging to one relayId — it becomes O(sessions for that
// relayId) instead. relayId is set once at record creation and never
// reassigned by any mutation below, so this only needs updating on ADD
// (createSession, mergeFromDisk's new-row branch) and REMOVE
// (pruneExpired) — every other mutation (revoke, activity touch,
// inactivity-timeout change) only touches fields already scoped to a known
// tokenHash and never needs this index to find them.
const relayIdIndex = new Map<string, Set<string>>();

function addToRelayIdIndex(record: SessionRecord): void {
  let set = relayIdIndex.get(record.relayId);
  if (!set) {
    set = new Set();
    relayIdIndex.set(record.relayId, set);
  }
  set.add(record.tokenHash);
}

function removeFromRelayIdIndex(record: SessionRecord): void {
  const set = relayIdIndex.get(record.relayId);
  if (!set) return;
  set.delete(record.tokenHash);
  if (set.size === 0) relayIdIndex.delete(record.relayId);
}

// Serialize writes the same way relay-server-db.ts does, to avoid
// TOCTOU races / torn writes against sessions.json.
let writeChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

// How often an already-loaded process re-reads sessions.json from disk.
// relay-node.ts runs as a separate OS process from the Next.js app (see
// docker-compose.yml — both containers mount the same `.data` volume) and
// never itself mutates the store, only reads it. Without a periodic
// refresh, the very first `ensureLoaded()` call in that process would
// freeze its in-memory `index` forever at whatever was on disk at that
// moment: a session revoked afterwards by the app process (logout-
// everywhere, WebAuthn revoke, the account-retention prune sweep) would
// never be seen, and the relay would keep trusting a live socket for that
// session indefinitely. 5s bounds that cross-process staleness to a small,
// cheap-to-poll window without adding a new IPC channel between the two
// processes — they already communicate this way (see hello-time ticket
// verification below, which predates this change).
const REFRESH_INTERVAL_MS = 5_000;
let lastRefreshedAt = 0;

async function readSessionsFromDisk(): Promise<SessionRecord[]> {
  try {
    const data = await fs.readFile(SESSIONS_FILE, 'utf-8');
    return JSON.parse(data) as SessionRecord[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Merge freshly-read disk rows into the in-memory index. A plain
 * wholesale replace would let a stale disk snapshot clobber a more-recent
 * in-memory mutation made by THIS process (e.g. a touchSessionActivity()
 * call not yet flushed to disk — see ACTIVITY_PERSIST_THROTTLE_MS), so
 * merge per-field conservatively instead: revocation is monotonic (once
 * true, never un-revoked) and lastActivityAt should only ever move
 * forward. Also backfills defaults for rows written by pre-upgrade code
 * that predates the lastActivityAt/inactivityTimeoutMs fields.
 */
function mergeFromDisk(rows: SessionRecord[]): void {
  for (const row of rows) {
    const existing = index.get(row.tokenHash);
    if (!existing) {
      const record: SessionRecord = {
        ...row,
        lastActivityAt: row.lastActivityAt ?? row.createdAt,
        inactivityTimeoutMs: row.inactivityTimeoutMs ?? null,
      };
      index.set(row.tokenHash, record);
      addToRelayIdIndex(record);
      continue;
    }
    existing.revoked = existing.revoked || row.revoked;
    existing.lastActivityAt = Math.max(existing.lastActivityAt ?? 0, row.lastActivityAt ?? 0);
    // Only relay-node reads this field, it never writes it — disk (written
    // by the app process via setInactivityTimeout) is always authoritative.
    existing.inactivityTimeoutMs = row.inactivityTimeoutMs ?? null;
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded && Date.now() - lastRefreshedAt < REFRESH_INTERVAL_MS) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        const rows = await readSessionsFromDisk();
        mergeFromDisk(rows);
        // pruneExpired() was previously only called from create/revoke
        // (below), which relay-node.ts never invokes — it only reads via
        // this periodic refresh (see REFRESH_INTERVAL_MS's comment above).
        // Without this, relay-node's local `index` only ever grew for the
        // entire lifetime of that always-on process, merging in every row
        // mergeFromDisk() sees on each 5s poll and never dropping any,
        // eventually OOMing a long-lived relay process. Pruning here means
        // every process refreshing this store drops its own expired local
        // entries, independent of whether it ever calls create/revoke
        // itself.
        pruneExpired();
        loaded = true;
        lastRefreshedAt = Date.now();
      } catch (err) {
        // readSessionsFromDisk() already maps a missing file to `[]`, so
        // anything that reaches here is a real failure (corrupt JSON,
        // permission error, disk error). On the very first load this must
        // propagate: swallowing it would leave `index` empty while
        // `loaded` silently became true, and the next persist() call
        // would overwrite sessions.json with that empty state,
        // permanently destroying every live session on disk. On a later
        // periodic refresh, `index` already holds good data from a prior
        // successful load — degrade gracefully (keep serving the
        // last-known-good in-memory state) and let the next call retry,
        // rather than taking every in-flight request down over a
        // transient disk hiccup.
        if (!loaded) throw err;
        log.warn('[session-store] Periodic refresh failed, continuing on last-known-good in-memory state:', err);
      } finally {
        loadPromise = null;
      }
    })();
  }
  await loadPromise;
}

/** True once a session has been idle longer than its configured threshold. */
function isIdleExpired(record: SessionRecord): boolean {
  if (!record.inactivityTimeoutMs) return false;
  return Date.now() - record.lastActivityAt > record.inactivityTimeoutMs;
}

// Throttle disk writes for activity touches — these fire on every
// authenticated HTTP request and every authenticated WS message, so
// persisting synchronously on each one would be a disk write per request.
// A crash between throttled flushes only loses a few seconds of
// lastActivityAt precision, and always fails toward a session looking
// MORE idle than it really is on restart (never less) — so this can't be
// used to keep a session alive past its configured timeout.
const ACTIVITY_PERSIST_THROTTLE_MS = 30_000;
let lastActivityPersistAt = 0;
let activityPersistPending = false;

function scheduleActivityPersist(): void {
  if (activityPersistPending) return;
  if (Date.now() - lastActivityPersistAt < ACTIVITY_PERSIST_THROTTLE_MS) return;
  activityPersistPending = true;
  lastActivityPersistAt = Date.now();
  void persist()
    .catch(() => { /* best-effort; the next touch retries */ })
    .finally(() => { activityPersistPending = false; });
}

async function persist(): Promise<void> {
  await withLock(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const rows = Array.from(index.values());
    await fs.writeFile(SESSIONS_TMP, JSON.stringify(rows, null, 2));
    await fs.rename(SESSIONS_TMP, SESSIONS_FILE);
  });
}

/** Drop expired sessions (revoked or not) to keep the store from growing forever. */
function pruneExpired(): boolean {
  const now = Date.now();
  let changed = false;
  for (const [hash, record] of index) {
    if (record.expiresAt < now) {
      index.delete(hash);
      removeFromRelayIdIndex(record);
      changed = true;
    }
  }
  return changed;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issue a new session for relayId. Returns the raw opaque token — this
 * value (and only this value) should be set as the client's cookie; it
 * is intentionally never itself stored, only its hash.
 */
export async function createSession(relayId: string): Promise<string> {
  await ensureLoaded();
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const record: SessionRecord = {
    tokenHash: hashToken(token),
    relayId,
    createdAt: now,
    expiresAt: now + SESSION_LIFETIME_MS,
    revoked: false,
    lastActivityAt: now,
    inactivityTimeoutMs: null,
  };
  index.set(record.tokenHash, record);
  addToRelayIdIndex(record);
  pruneExpired();
  await persist();
  return token;
}

/**
 * Verify an opaque session token. Returns the relayId if the token maps
 * to a live (non-revoked, non-expired) session, else null.
 *
 * Fast path: in-memory Map lookup only — safe to call on every
 * authenticated request.
 */
export async function verifySessionToken(token: string): Promise<string | null> {
  await ensureLoaded();
  const record = index.get(hashToken(token));
  if (!record) return null;
  if (record.revoked) return null;
  if (Date.now() > record.expiresAt) return null;
  if (isIdleExpired(record)) return null;
  return record.relayId;
}

/**
 * Check whether a *hash* of a session token (as embedded in a WS ticket,
 * for example) still corresponds to a live session for relayId. Lets a
 * caller confirm liveness without ever handling the raw token.
 */
export async function isSessionValidByHash(tokenHash: string, relayId: string): Promise<boolean> {
  await ensureLoaded();
  const record = index.get(tokenHash);
  if (!record) return false;
  if (record.relayId !== relayId) return false;
  if (record.revoked) return false;
  if (Date.now() > record.expiresAt) return false;
  if (isIdleExpired(record)) return false;
  return true;
}

/**
 * Record that a session (identified by its tokenHash) was just used — call
 * on every authenticated HTTP request (see getSessionRelayId in
 * server-session.ts) and every authenticated WS message (see
 * server/relay-node.ts). Backs isIdleExpired()/the inactivity-timeout
 * checks in verifySessionToken/isSessionValidByHash above: independent of
 * whatever the client's own inactivity timer does (or fails to do — a
 * tampered/compromised client could simply never run it), a session with
 * no recorded activity for longer than its configured inactivityTimeoutMs
 * stops verifying.
 */
export async function touchSessionActivity(tokenHash: string): Promise<void> {
  await ensureLoaded();
  const record = index.get(tokenHash);
  if (!record || record.revoked) return;
  record.lastActivityAt = Date.now();
  scheduleActivityPersist();
}

/**
 * Set (or clear, with null) the configured inactivity-timeout threshold
 * for a single session — mirrors the client's per-device auto-logout
 * setting (lib/auth/auto-logout.ts) so the server can enforce it
 * independent of the client. Synced from the client whenever the setting
 * changes (see app/api/auth/session-settings/route.ts). No-op if the
 * token is unknown/already revoked.
 */
export async function setInactivityTimeout(token: string, timeoutMs: number | null): Promise<void> {
  await ensureLoaded();
  const record = index.get(hashToken(token));
  if (!record || record.revoked) return;
  record.inactivityTimeoutMs = timeoutMs;
  await persist();
}

/** Revoke a single session (e.g. on logout). No-op if unknown/already revoked. */
export async function revokeSession(token: string): Promise<void> {
  await ensureLoaded();
  const record = index.get(hashToken(token));
  if (!record || record.revoked) return;
  record.revoked = true;
  pruneExpired();
  await persist();
}

/**
 * Revoke every outstanding session belonging to relayId ("log out
 * everywhere", or defensively on credential change). Any API call or WS
 * ticket mint/verification relying on one of those sessions will fail
 * afterwards.
 */
export async function revokeAllSessions(relayId: string): Promise<void> {
  await ensureLoaded();
  let changed = false;
  const tokenHashes = relayIdIndex.get(relayId);
  if (tokenHashes) {
    for (const hash of tokenHashes) {
      const record = index.get(hash);
      if (record && !record.revoked) {
        record.revoked = true;
        changed = true;
      }
    }
  }
  if (changed) await persist();
}
