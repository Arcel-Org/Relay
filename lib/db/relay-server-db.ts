/**
 * Server-side user database — libSQL (embedded SQLite), see sqlite-client.ts.
 */
import { getDb, runWriteTransaction } from './sqlite-client';
import { generateShortCode, isReservedHandle } from '@/lib/crypto/relay-id';
import type { Row } from '@libsql/client';

export interface RelayUser {
  id: string; // UUID
  relayId: string; // e.g. a1b2-c3d4-e5f6-...-9988 (8 dash-separated hex groups)
  publicKeyHex: string; // hex encoded X25519 public key
  encryptedTOTPSecret: string; // AES-256-GCM-encrypted (server key) TOTP secret hex
  encryptedTOTPSecretForRecovery: string; // hex encoded TOTP secret encrypted with recovery code
  createdAt: number; // timestamp
  lastLogin?: number;
  // Post-quantum cryptography
  pqPublicKeyHex?: string; // hex encoded ML-KEM768 public key (optional for backward compat)
  // Profile fields
  displayName?: string; // User's chosen display name
  username?: string; // User's @username
  bio?: string; // User's bio
  isUnlisted?: boolean; // Privacy: hide from directory
  recoveryCodeHash?: string; // SHA-256 hash of recovery code for account recovery
  // Avatar — assigned once at signup, permanently immutable
  avatarEmoji?: string; // e.g. "🦊"
  avatarColor?: string; // e.g. "#e94040" — random hex
  // Per-account auth lockout (relayId-keyed, not IP-keyed — privacy-preserving)
  failedLoginAttempts?: number;
  lockedUntil?: number; // ms epoch; if > now, login is rejected
  // Second-factor method chosen at signup. 'webauthn' accounts still have an
  // encryptedTOTPSecretForRecovery (recovery-code login is unaffected either way).
  twoFactorMethod?: 'totp' | 'webauthn';
  // Opt-in short discoverability code (e.g. `xoep-4910`) — randomly
  // generated, not derived from anything, unset unless the user explicitly
  // requested one (see generateAndAssignShortCode/clearShortCode below).
  shortCode?: string;
}

function rowToUser(row: Row): RelayUser {
  const user: RelayUser = {
    id: row.id as string,
    relayId: row.relayId as string,
    publicKeyHex: row.publicKeyHex as string,
    encryptedTOTPSecret: row.encryptedTOTPSecret as string,
    encryptedTOTPSecretForRecovery: (row.encryptedTOTPSecretForRecovery as string) ?? '',
    createdAt: Number(row.createdAt),
  };
  if (row.lastLogin !== null && row.lastLogin !== undefined) user.lastLogin = Number(row.lastLogin);
  if (row.pqPublicKeyHex) user.pqPublicKeyHex = row.pqPublicKeyHex as string;
  if (row.displayName) user.displayName = row.displayName as string;
  if (row.username) user.username = row.username as string;
  if (row.bio) user.bio = row.bio as string;
  if (row.isUnlisted) user.isUnlisted = Boolean(row.isUnlisted);
  if (row.recoveryCodeHash) user.recoveryCodeHash = row.recoveryCodeHash as string;
  if (row.avatarEmoji) user.avatarEmoji = row.avatarEmoji as string;
  if (row.avatarColor) user.avatarColor = row.avatarColor as string;
  user.failedLoginAttempts = Number(row.failedLoginAttempts ?? 0);
  if (row.lockedUntil !== null && row.lockedUntil !== undefined) user.lockedUntil = Number(row.lockedUntil);
  user.twoFactorMethod = (row.twoFactorMethod as 'totp' | 'webauthn') || 'totp';
  if (row.shortCode) user.shortCode = row.shortCode as string;
  return user;
}

/**
 * Get user by relayId
 */
export async function getUserByRelayId(relayId: string): Promise<RelayUser | null> {
  const db = await getDb();
  const result = await db.execute({ sql: 'SELECT * FROM users WHERE relayId = ?', args: [relayId] });
  return result.rows.length ? rowToUser(result.rows[0]) : null;
}

/**
 * Get user by ID
 */
export async function getUserById(id: string): Promise<RelayUser | null> {
  const db = await getDb();
  const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
  return result.rows.length ? rowToUser(result.rows[0]) : null;
}

/**
 * Save or update a user (upsert by id)
 */
export async function saveUser(user: RelayUser): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `
      INSERT INTO users (
        id, relayId, publicKeyHex, encryptedTOTPSecret, encryptedTOTPSecretForRecovery,
        createdAt, lastLogin, pqPublicKeyHex, displayName, username, bio, isUnlisted,
        recoveryCodeHash, avatarEmoji, avatarColor, failedLoginAttempts, lockedUntil, twoFactorMethod,
        shortCode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        relayId = excluded.relayId,
        publicKeyHex = excluded.publicKeyHex,
        encryptedTOTPSecret = excluded.encryptedTOTPSecret,
        encryptedTOTPSecretForRecovery = excluded.encryptedTOTPSecretForRecovery,
        createdAt = excluded.createdAt,
        lastLogin = excluded.lastLogin,
        pqPublicKeyHex = excluded.pqPublicKeyHex,
        displayName = excluded.displayName,
        username = excluded.username,
        bio = excluded.bio,
        isUnlisted = excluded.isUnlisted,
        recoveryCodeHash = excluded.recoveryCodeHash,
        avatarEmoji = excluded.avatarEmoji,
        avatarColor = excluded.avatarColor,
        failedLoginAttempts = excluded.failedLoginAttempts,
        lockedUntil = excluded.lockedUntil,
        twoFactorMethod = excluded.twoFactorMethod,
        shortCode = excluded.shortCode
    `,
    args: [
      user.id,
      user.relayId,
      user.publicKeyHex,
      user.encryptedTOTPSecret,
      user.encryptedTOTPSecretForRecovery ?? '',
      user.createdAt,
      user.lastLogin ?? null,
      user.pqPublicKeyHex ?? null,
      user.displayName ?? null,
      user.username ?? null,
      user.bio ?? null,
      user.isUnlisted ? 1 : null,
      user.recoveryCodeHash ?? null,
      user.avatarEmoji ?? null,
      user.avatarColor ?? null,
      user.failedLoginAttempts ?? 0,
      user.lockedUntil ?? null,
      user.twoFactorMethod ?? 'totp',
      user.shortCode ?? null,
    ],
  });
}

/**
 * Get all users
 */
export async function getAllUsers(): Promise<RelayUser[]> {
  const db = await getDb();
  const result = await db.execute('SELECT * FROM users');
  return result.rows.map(rowToUser);
}

/**
 * Bounded candidate fetch for username search (app/api/profile/search) —
 * capped at `cap` regardless of total user count, so the caller's
 * per-request scoring/Levenshtein cost stays flat as the table grows
 * instead of scaling with it (unlike calling getAllUsers() from a
 * request handler, which does an unbounded full-table scan on every
 * search). Combines a substring match (covers exact/prefix/contains — all
 * cheap, native SQLite string comparison) with a small flat-capped
 * fallback batch for typo-tolerant (edit-distance) matching, which can't
 * be expressed in SQL and has to run in JS.
 */
export async function getUsernameSearchCandidates(
  substringQuery: string,
  excludeRelayId: string | null,
  cap: number
): Promise<RelayUser[]> {
  const db = await getDb();
  const [substringResult, fuzzyFallbackResult] = await Promise.all([
    db.execute({
      sql: `
        SELECT * FROM users
        WHERE username IS NOT NULL AND (isUnlisted IS NULL OR isUnlisted = 0)
          AND (? IS NULL OR relayId != ?)
          AND lower(username) LIKE '%' || lower(?) || '%'
        ORDER BY length(username) ASC
        LIMIT ?
      `,
      args: [excludeRelayId, excludeRelayId, substringQuery, cap],
    }),
    db.execute({
      sql: `
        SELECT * FROM users
        WHERE username IS NOT NULL AND (isUnlisted IS NULL OR isUnlisted = 0)
          AND (? IS NULL OR relayId != ?)
        LIMIT ?
      `,
      args: [excludeRelayId, excludeRelayId, cap],
    }),
  ]);

  const candidates = new Map<string, RelayUser>();
  for (const row of substringResult.rows) {
    const user = rowToUser(row);
    candidates.set(user.relayId, user);
  }
  for (const row of fuzzyFallbackResult.rows) {
    const user = rowToUser(row);
    if (!candidates.has(user.relayId)) candidates.set(user.relayId, user);
  }
  return Array.from(candidates.values());
}

/**
 * Delete a user
 */
export async function deleteUser(id: string): Promise<void> {
  const db = await getDb();
  await runWriteTransaction(db, async (tx) => {
    const result = await tx.execute({ sql: 'SELECT relayId FROM users WHERE id = ?', args: [id] });
    const relayId = result.rows.length ? (result.rows[0].relayId as string) : null;
    await tx.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [id] });
    if (relayId) {
      // public_groups.ownerRelayId has no FK to users — without this, a
      // deleted owner's public group stays listed in the directory forever
      // with no way to ever pass an ownership check again (see
      // groups/leave-directory's ownership check). There's no group-
      // ownership-transfer feature, so delisting is the only correct
      // outcome here, not a cascade of the group's actual membership data
      // (which lives in the encrypted invite flow, untouched by this).
      await tx.execute({ sql: 'DELETE FROM public_groups WHERE ownerRelayId = ?', args: [relayId] });
    }
    await tx.commit();
  });
}

/**
 * Update last login timestamp and clear any lockout state.
 */
export async function updateLastLogin(relayId: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE users SET lastLogin = ?, failedLoginAttempts = 0, lockedUntil = NULL WHERE relayId = ?',
    args: [Date.now(), relayId],
  });
}

// Per-account PIN/TOTP lockout (A1) — relayId-keyed, no IP involvement.
// Threshold: 10 failures → 15-min lockout; resets on successful login.
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// Serializes the whole "check isLocked -> verify second factor ->
// recordFailedLogin" sequence per relayId (login/route.ts,
// recovery-login/route.ts, regenerate-recovery-code/route.ts). Without
// this, a burst of N concurrent login attempts for the SAME relayId can
// all read isLocked()=false before any of them commits a failure — the
// stored attempt counter itself was already correct (recordFailedLogin's
// own transaction always reads fresh state), but the isLocked() gate
// checked earlier in each request, before the expensive crypto
// verification, could be stale, letting a well-timed burst get more
// concurrent verification attempts through in one shot than the 10-guess
// budget was meant to allow before any of them saw a locked response.
// Mirrors session-store.ts's withLock write-serialization pattern, just
// keyed per-relayId instead of global — legitimate concurrent logins from
// different devices for the same account only ever wait on fast in-memory
// crypto verification (milliseconds), not I/O.
const loginAttemptLocks = new Map<string, Promise<unknown>>();

export function withLoginAttemptLock<T>(relayId: string, fn: () => Promise<T>): Promise<T> {
  const prev = loginAttemptLocks.get(relayId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.catch(() => undefined);
  loginAttemptLocks.set(relayId, settled);
  // Self-cleaning: once this call's chain link settles, drop the map entry
  // — but only if nothing newer got chained onto it in the meantime (an
  // unconditional delete here could race and remove a DIFFERENT, still-
  // pending later call's entry). Without this, loginAttemptLocks would
  // grow by one entry per distinct relayId that has ever attempted a
  // login, forever, for the lifetime of the process.
  void settled.then(() => {
    if (loginAttemptLocks.get(relayId) === settled) loginAttemptLocks.delete(relayId);
  });
  return next;
}

export async function recordFailedLogin(
  relayId: string
): Promise<{ locked: boolean; lockedUntil?: number }> {
  const db = await getDb();
  return runWriteTransaction(db, async (tx) => {
    const result = await tx.execute({
      sql: 'SELECT failedLoginAttempts, lockedUntil FROM users WHERE relayId = ?',
      args: [relayId],
    });
    if (!result.rows.length) {
      await tx.commit();
      return { locked: false };
    }
    const row = result.rows[0];
    const previousLockedUntil =
      row.lockedUntil !== null && row.lockedUntil !== undefined ? Number(row.lockedUntil) : null;
    // An expired lock shouldn't leave the counter sitting at/above
    // LOCKOUT_THRESHOLD forever — without this, the very next attempt after
    // a lock naturally expires re-locks instantly regardless of whether
    // it's correct (count was already >= threshold and only grows), so a
    // single post-expiry typo (or one more attempt from an attacker) keeps
    // the account effectively locked out indefinitely. Treat an elapsed
    // lock as a fresh start for the counter.
    const previousCount =
      previousLockedUntil !== null && previousLockedUntil <= Date.now()
        ? 0
        : Number(row.failedLoginAttempts ?? 0);
    const count = previousCount + 1;
    let locked = false;
    let lockedUntil: number | undefined;
    if (count >= LOCKOUT_THRESHOLD) {
      lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
      locked = true;
    }
    await tx.execute({
      sql: 'UPDATE users SET failedLoginAttempts = ?, lockedUntil = ? WHERE relayId = ?',
      args: [count, lockedUntil ?? null, relayId],
    });
    await tx.commit();
    return { locked, lockedUntil };
  });
}

export function isLocked(user: Pick<RelayUser, 'lockedUntil'>): number | null {
  if (user.lockedUntil && user.lockedUntil > Date.now()) return user.lockedUntil;
  return null;
}

/**
 * Targeted column update — unlike saveUser() (a full-row upsert), this can't
 * lose a concurrent write to any other column (e.g. a profile update landing
 * between this read and write).
 *
 * recoveryCodeHash and encryptedTOTPSecretForRecovery are written together in
 * one statement deliberately — recovery-login requires both to match the
 * same recovery code (the TOTP secret is decrypted using the code as key
 * material). Writing them as two separate round trips let a dropped
 * connection between them permanently break recovery: the new hash would
 * verify but decrypt garbage, and the old hash (which matched the still-live
 * encrypted blob) would already be gone.
 */
export async function updateRecoveryCode(
  relayId: string,
  recoveryCodeHash: string,
  encryptedTOTPSecretForRecovery: string
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE users SET recoveryCodeHash = ?, encryptedTOTPSecretForRecovery = ? WHERE relayId = ?',
    args: [recoveryCodeHash, encryptedTOTPSecretForRecovery, relayId],
  });
}

/**
 * Lazily assign an avatar to a legacy account that predates the avatar
 * feature. The `avatarEmoji IS NULL` guard makes this a conditional update
 * rather than a full-row upsert — it can't revert a concurrent profile edit.
 */
export async function updateAvatarIfMissing(relayId: string, avatarEmoji: string, avatarColor: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE users SET avatarEmoji = ?, avatarColor = ? WHERE relayId = ? AND avatarEmoji IS NULL',
    args: [avatarEmoji, avatarColor, relayId],
  });
}

/**
 * Update user profile info (displayName, username, bio, isUnlisted)
 */
export class UsernameConflictError extends Error {
  constructor() { super('USERNAME_TAKEN'); this.name = 'UsernameConflictError'; }
}

// The reserved-handle check previously only existed client-side
// (lib/auth/account-manager.ts's claimUsername) — a client bypassing that
// UI entirely and POSTing straight to /api/profile/update could claim
// "admin"/"support"/etc. Enforced here too, server-side, where it can't be
// skipped.
export class ReservedUsernameError extends Error {
  constructor() { super('USERNAME_RESERVED'); this.name = 'ReservedUsernameError'; }
}

export async function updateUserProfile(
  relayId: string,
  profile: {
    displayName?: string | null;
    username?: string | null;
    bio?: string | null;
    isUnlisted?: boolean;
    // avatarEmoji and avatarColor are intentionally excluded — they are immutable after signup
  }
): Promise<RelayUser | null> {
  const db = await getDb();
  return runWriteTransaction(db, async (tx) => {
    const existingResult = await tx.execute({ sql: 'SELECT * FROM users WHERE relayId = ?', args: [relayId] });
    if (!existingResult.rows.length) {
      await tx.commit();
      return null;
    }
    const user = rowToUser(existingResult.rows[0]);

    if (profile.displayName !== undefined) {
      user.displayName = profile.displayName === null || profile.displayName === '' ? undefined : profile.displayName;
    }
    if (profile.username !== undefined) {
      if (profile.username === null || profile.username === '') {
        user.username = undefined;
      } else {
        if (isReservedHandle(profile.username)) throw new ReservedUsernameError();
        // Z2: uniqueness check inside the same transaction — atomic, no TOCTOU window.
        const conflict = await tx.execute({
          sql: 'SELECT 1 FROM users WHERE relayId != ? AND lower(username) = lower(?) LIMIT 1',
          args: [relayId, profile.username],
        });
        // Throwing here (without commit) leaves the transaction uncommitted —
        // the finally block's tx.close() below implicitly rolls it back.
        if (conflict.rows.length) throw new UsernameConflictError();
        user.username = profile.username;
      }
    }
    if (profile.bio !== undefined) {
      user.bio = profile.bio === null || profile.bio === '' ? undefined : profile.bio;
    }
    if (profile.isUnlisted !== undefined) {
      user.isUnlisted = profile.isUnlisted;
    }

    await tx.execute({
      sql: `UPDATE users SET displayName = ?, username = ?, bio = ?, isUnlisted = ? WHERE relayId = ?`,
      args: [
        user.displayName ?? null,
        user.username ?? null,
        user.bio ?? null,
        user.isUnlisted ? 1 : null,
        relayId,
      ],
    });
    await tx.commit();
    return user;
  });
}

/**
 * Get user profile by username
 */
export async function getUserByUsername(username: string): Promise<RelayUser | null> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE lower(username) = lower(?)',
    args: [username],
  });
  return result.rows.length ? rowToUser(result.rows[0]) : null;
}

/**
 * Get user by opt-in short code (e.g. `xoep-4910`)
 */
export async function getUserByShortCode(shortCode: string): Promise<RelayUser | null> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE lower(shortCode) = lower(?)',
    args: [shortCode],
  });
  return result.rows.length ? rowToUser(result.rows[0]) : null;
}

export class ShortCodeConflictError extends Error {
  constructor() { super('SHORT_CODE_TAKEN'); this.name = 'ShortCodeConflictError'; }
}

const MAX_SHORT_CODE_ATTEMPTS = 20;

/**
 * Generate a fresh short code and assign it to relayId, retrying on
 * collision. Unlike username (user-typed, one attempt, conflict surfaced to
 * the user), the caller doesn't care WHICH code they get — so retrying
 * server-side avoids a client round-trip per collision. 26^4 * 10^4 (~4.5
 * billion possible codes) makes more than a couple of retries astronomically
 * unlikely; the cap just bounds worst case rather than looping forever.
 */
type ShortCodeAttemptOutcome =
  | { ok: true; candidate: string }
  | { ok: false; reason: 'not-found' | 'collision' };

export async function generateAndAssignShortCode(relayId: string): Promise<string> {
  const db = await getDb();
  for (let attempt = 0; attempt < MAX_SHORT_CODE_ATTEMPTS; attempt++) {
    const candidate = generateShortCode();
    // Reject a reserved handle (e.g. "help-1234") before even opening a
    // transaction — treated exactly like a DB collision: skip and retry
    // with a fresh candidate. Checked against the letters portion only,
    // since RESERVED_HANDLES are words, not letters+digits pairs.
    if (isReservedHandle(candidate.split('-')[0])) continue;
    const outcome: ShortCodeAttemptOutcome = await runWriteTransaction(db, async (tx) => {
      const existingUser = await tx.execute({ sql: 'SELECT 1 FROM users WHERE relayId = ?', args: [relayId] });
      if (!existingUser.rows.length) {
        await tx.commit();
        return { ok: false, reason: 'not-found' };
      }
      const conflict = await tx.execute({
        sql: 'SELECT 1 FROM users WHERE relayId != ? AND lower(shortCode) = lower(?) LIMIT 1',
        args: [relayId, candidate],
      });
      if (conflict.rows.length) {
        await tx.commit(); // nothing written; just release and retry with a new candidate
        return { ok: false, reason: 'collision' };
      }
      await tx.execute({ sql: 'UPDATE users SET shortCode = ? WHERE relayId = ?', args: [candidate, relayId] });
      await tx.commit();
      return { ok: true, candidate };
    });
    if (!outcome.ok && outcome.reason === 'not-found') throw new Error('User not found');
    if (outcome.ok) return outcome.candidate;
    // collision — loop continues to the next candidate
  }
  throw new Error('Failed to generate a unique short code after maximum attempts');
}

/** Remove a user's short code (they can always generate a new one later). */
export async function clearShortCode(relayId: string): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: 'UPDATE users SET shortCode = NULL WHERE relayId = ?', args: [relayId] });
}
