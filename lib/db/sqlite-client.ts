/**
 * Server-side database — libSQL (SQLite-compatible), embedded file mode.
 *
 * Single-server, low-write-volume deployment: real transactions and indexes
 * replace the old JSON-file-plus-process-mutex store, without adding any
 * network hop or external infra. The libSQL client also supports pointing
 * `DATABASE_URL` at a remote/embedded-replica primary later (Turso) with no
 * code change here if multi-instance scaling is ever needed.
 */
import { createClient, LibsqlError, type Client, type Transaction } from '@libsql/client';
import fs from 'fs';
import path from 'path';

// Overridable so tests (and alternate deployments) can point the DB at an
// isolated directory instead of the real `.data` used by the app — mirrors
// session-store.ts's DATA_DIR override pattern.
const DB_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
const DEFAULT_URL = `file:${path.join(DB_DIR, 'relay.db')}`;

// Backed by globalThis, not plain module-scope `let` bindings — Next.js's
// server build traces/bundles each API route into its own largely self-
// contained chunk, which can produce SEPARATE instantiations of this same
// source file's module scope within a single process (confirmed via the
// e2e harness: one process, one pid, yet `migrated` was observed flipping
// from true back to false partway through a run — impossible for a single
// real module instance, since a fulfilled promise never un-resolves).
// Each duplicate instance held its own `client`/`migrated`, so one route's
// successful migration (and the table it created) was invisible to a
// DIFFERENT route's independent copy, which sometimes ran its own migration
// against an overlapping window and left its own connection's view of the
// schema inconsistent — manifesting as "no such table: banned_relay_ids"
// on some requests but not others, entirely deterministically once a given
// bundle chunk's own copy got into that state. globalThis is the one truly
// process-wide object every bundled chunk shares, so anchoring the cache
// there (the standard fix for this exact class of Next.js server-singleton
// bug) guarantees only one Client/migration ever exists per process
// regardless of how the build happens to chunk this module.
//
// Keyed by the resolved connection URL (Maps), not one bare global slot —
// a real deployment's URL is fixed for the process's whole lifetime, so
// this behaves exactly like a singleton there. But many DB unit tests
// (see lib/__tests__/*-db.test.ts) point DATA_DIR at a fresh temp directory
// per test via `vi.resetModules()`, expecting a genuinely fresh client each
// time — a single global slot broke that (confirmed: the old client, still
// pointing at a previous test's since-deleted temp dir, was reused instead
// of a new one being created). Keying by URL gives each test's distinct
// DATA_DIR its own map entry automatically, with no test file needing to
// know this caching exists at all.
const globalForDb = globalThis as unknown as {
  __relayDbClients?: Map<string, Client>;
  __relayDbMigrations?: Map<string, Promise<void>>;
};

function resolveUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_URL;
}

function getClient(): Client {
  const url = resolveUrl();
  if (!globalForDb.__relayDbClients) globalForDb.__relayDbClients = new Map();
  let client = globalForDb.__relayDbClients.get(url);
  if (!client) {
    if (!process.env.DATABASE_URL) {
      // Embedded file-mode DB: a fresh deploy/container has no `.data`
      // directory yet, and libSQL does not create parent directories for
      // us — without this, first boot fails with ENOENT instead of
      // creating the DB file.
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
    client.execute = wrapExecute(client, url);
    globalForDb.__relayDbClients.set(url, client);
  }
  return client;
}

/**
 * Evict the cached client/migration state for a URL and close the old
 * client's connection. Used when a bare execute() hits a stale-schema error
 * (see wrapExecute below) — the next getClient()/getDb() call builds a
 * genuinely fresh connection against the same on-disk file instead of
 * continuing to use one stuck on a bad snapshot.
 */
function evictClient(url: string): void {
  const old = globalForDb.__relayDbClients?.get(url);
  globalForDb.__relayDbClients?.delete(url);
  globalForDb.__relayDbMigrations?.delete(url);
  old?.close();
}

// A bare (non-transactional) db.execute() call has been observed, empirically
// and reproducibly via the e2e harness, to permanently return "no such
// table"/"no such column" for tables that demonstrably exist and that the
// SAME client had successfully created via a committed BEGIN IMMEDIATE
// migration transaction earlier in the same process — confirmed via direct
// instrumentation that this is not transient (it never self-heals on retry
// against the same connection) and not a duplicate-client bug (only one
// client is ever created). This matches a known category of libSQL local-
// embedded-mode issue: a connection's read snapshot getting pinned stale and
// never advancing. The only mechanism confirmed to recover from it is a
// genuinely fresh connection against the same file (the data is intact on
// disk regardless of which connection's in-memory state is stuck) — so this
// wraps plain execute() to detect exactly that error shape, evict the
// client, and retry once against a freshly opened one.
const STALE_SCHEMA_ERROR = /no such (table|column)/i;

// Keyed by client instance so a retry (see below) can call the fresh
// client's TRUE unwrapped execute directly — going through the wrapped
// version again would re-enter this same catch block on a second failure
// and retry forever instead of surfacing a real, persistent error.
const originalExecuteByClient = new WeakMap<Client, Client['execute']>();

function wrapExecute(client: Client, url: string): Client['execute'] {
  const original = client.execute.bind(client);
  originalExecuteByClient.set(client, original);
  return (async (...args: Parameters<Client['execute']>) => {
    try {
      return await original(...args);
    } catch (err) {
      if (err instanceof LibsqlError && STALE_SCHEMA_ERROR.test(err.message)) {
        evictClient(url);
        const fresh = await getDb();
        const freshOriginal = originalExecuteByClient.get(fresh) ?? fresh.execute.bind(fresh);
        return freshOriginal(...args);
      }
      throw err;
    }
  }) as Client['execute'];
}

async function runMigrations(db: Client): Promise<void> {
  // WAL is the right default for a normal, unshared production deployment
  // (Docker volume, bare-metal PM2) — better write throughput, concurrent
  // readers don't block a writer. SQLITE_JOURNAL_MODE is an escape hatch:
  // this repo's own dev sandbox reproducibly hits schema-level corruption
  // under WAL ("no such table" on a table that demonstrably existed via the
  // SAME live connection moments earlier) that was never fully root-caused
  // despite testing storage location (ZFS-backed vs tmpfs), transaction
  // wrapping, and journal mode (DELETE, TRUNCATE) in isolation — none of
  // those alone made it fully reliable either. If you hit table-not-found
  // errors here that don't match any real schema change, this is worth
  // trying, but treat it as a workaround for an unresolved environment
  // quirk, not a verified fix.
  const VALID_JOURNAL_MODES = new Set(['WAL', 'DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'OFF']);
  const journalMode = (process.env.SQLITE_JOURNAL_MODE || 'WAL').toUpperCase();
  if (!VALID_JOURNAL_MODES.has(journalMode)) {
    throw new Error(`Invalid SQLITE_JOURNAL_MODE "${process.env.SQLITE_JOURNAL_MODE}" — must be one of ${[...VALID_JOURNAL_MODES].join(', ')}`);
  }
  // PRAGMA doesn't support bound parameters for its value, but the string
  // is validated against a fixed allowlist above, not passed through raw —
  // this is not string-interpolated user input.
  await db.execute(`PRAGMA journal_mode = ${journalMode}`);
  // SQLite's synchronous setting defaults to FULL regardless of journal
  // mode unless explicitly changed — under WAL specifically, FULL fsyncs
  // on every transaction commit, which (combined with SQLite's single-
  // writer model — every write in this whole process is already
  // serialized) makes disk fsync latency the write-throughput ceiling.
  // NORMAL is the standard, well-documented recommended pairing with WAL:
  // it still fsyncs at WAL checkpoints (so the database file itself can
  // never be corrupted), it just doesn't fsync on every single commit —
  // the only risk is losing the most recent transaction(s) on a power
  // loss/OS crash (not application crash, and not corruption), which is an
  // accepted, standard trade-off for the write-throughput this buys back.
  await db.execute('PRAGMA synchronous = NORMAL');
  // Both PRAGMAs above run outside any transaction — foreign_keys in
  // particular is a documented no-op if set while a transaction is active,
  // so it must happen before the BEGIN IMMEDIATE below, not inside it.
  await db.execute('PRAGMA foreign_keys = ON');

  // Everything that changes schema (CREATE TABLE etc.) is wrapped in one
  // BEGIN IMMEDIATE transaction — the app server and the relay server are
  // separate OS processes that each open their own libSQL Client against
  // the same on-disk file (relay-node.ts → lib/push/send-push-notification.ts
  // → lib/db/push-tokens.ts also calls getDb()), so on a brand-new database
  // both can start migrating concurrently. Reproduced via the e2e harness
  // (tests/e2e/): unwrapped, auto-committing CREATE TABLE statements from
  // two processes interleaving against a freshly-created WAL file left one
  // process's connection permanently unable to see a table the OTHER
  // process had created (e.g. "no such table: banned_relay_ids"), even
  // though the table existed on disk. BEGIN IMMEDIATE takes a real write
  // lock for the whole sequence, so the losing process gets a clean
  // SQLITE_BUSY on transaction start (retried by getDb()'s caller below)
  // instead of two DDL streams interleaving mid-migration.
  const tx = await db.transaction('write');
  try {
    await runSchemaMigrations(tx);
    await tx.commit();
  } finally {
    await tx.close();
  }
}

async function runSchemaMigrations(db: Transaction): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      relayId TEXT UNIQUE NOT NULL,
      publicKeyHex TEXT NOT NULL,
      encryptedTOTPSecret TEXT NOT NULL,
      encryptedTOTPSecretForRecovery TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL,
      lastLogin INTEGER,
      pqPublicKeyHex TEXT,
      displayName TEXT,
      username TEXT,
      bio TEXT,
      isUnlisted INTEGER,
      recoveryCodeHash TEXT,
      avatarEmoji TEXT,
      avatarColor TEXT,
      failedLoginAttempts INTEGER NOT NULL DEFAULT 0,
      lockedUntil INTEGER,
      shortCode TEXT
    )
  `);
  // Case-insensitive uniqueness is enforced in application code (SQLite's
  // default UNIQUE index is case-sensitive).
  await db.execute('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');
  // relay-server-db.ts's uniqueness check and getUserByUsername() both query
  // with `lower(username) = lower(?)` — a plain index on the raw column
  // (above) cannot satisfy that predicate, forcing a full table scan on
  // every profile update and username lookup. This expression index lets
  // SQLite seek instead.
  await db.execute('CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users(lower(username))');

  // Added after the initial schema — guarded because SQLite has no
  // `ADD COLUMN IF NOT EXISTS`. Existing rows default to 'totp' (unchanged
  // login behavior for every account created before this feature).
  try {
    await db.execute("ALTER TABLE users ADD COLUMN twoFactorMethod TEXT NOT NULL DEFAULT 'totp'");
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err;
  }

  // Opt-in short discoverability code (e.g. `xoep-4910`) — added after the
  // initial schema, same guarded-ALTER pattern as twoFactorMethod above, for
  // any dev DB file created before this existed. NULL by default: most
  // accounts have no short code until they explicitly opt in.
  try {
    await db.execute('ALTER TABLE users ADD COLUMN shortCode TEXT');
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err;
  }
  // Random, not derived from anything — uniqueness must be enforced the same
  // way username's is: an expression index for the lower(shortCode) = ?
  // predicate the claim/lookup queries use (shortCode is always generated
  // lowercase, but this also covers any future case-insensitive input).
  await db.execute('CREATE INDEX IF NOT EXISTS idx_users_shortcode_lower ON users(lower(shortCode))');

  await db.execute(`
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      credentialId TEXT PRIMARY KEY,
      relayId TEXT NOT NULL REFERENCES users(relayId) ON DELETE CASCADE,
      publicKeyHex TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      createdAt INTEGER NOT NULL
    )
  `);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_webauthn_relayId ON webauthn_credentials(relayId)');

  await db.execute(`
    CREATE TABLE IF NOT EXISTS public_groups (
      groupId TEXT PRIMARY KEY,
      publicHandle TEXT UNIQUE NOT NULL,
      -- publicHandle's UNIQUE constraint above creates a case-sensitive
      -- index; findByHandle()/joinGroup() query with lower(publicHandle)
      -- = ?, which needs the separate expression index created below.
      name TEXT NOT NULL,
      description TEXT,
      avatarEmoji TEXT,
      avatarColor TEXT,
      memberCount INTEGER NOT NULL DEFAULT 1,
      -- No REFERENCES/ON DELETE here (unlike webauthn_credentials/
      -- relay-server-db.ts's deleteUser() handles
      -- cleanup at the application level instead: delisting (not cascading
      -- membership data for) any group the deleted user owned. Ownership
      -- CAN change without a delete now (see updateGroupOwner, used by
      -- POST /api/groups/transfer-owner), which is exactly why this column
      -- has no FK — a live group's owner is expected to change over time.
      ownerRelayId TEXT NOT NULL,
      joinPolicy TEXT NOT NULL DEFAULT 'open',
      pendingMembers TEXT NOT NULL DEFAULT '[]',
      pendingRequests TEXT NOT NULL DEFAULT '[]',
      updatedAt INTEGER NOT NULL
    )
  `);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_public_groups_handle_lower ON public_groups(lower(publicHandle))');

  // Deliberately NO reporter-identity column of any kind. The whole point of
  // this table is that a subpoena for "everything you have on relayId X" can
  // never surface who reported whom — only that X was reported, how many
  // times, for what category, and when. Reports are reviewed manually by the
  // operator (there is no automatic ban-at-N-reports rule: a report count
  // alone is trivially gamed by a phone farm / sock-puppet cluster, so a
  // threshold-triggered ban would just become a griefing tool). No FK to
  // users(relayId) — a target's row must survive that account's own
  // deletion/ban so the operator can still see report history for review,
  // matching public_groups.ownerRelayId's no-FK reasoning above.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS abuse_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      targetRelayId TEXT NOT NULL,
      category TEXT NOT NULL,
      note TEXT,
      createdAt INTEGER NOT NULL,
      resolvedAt INTEGER,
      resolution TEXT
    )
  `);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_abuse_reports_target ON abuse_reports(targetRelayId)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_abuse_reports_resolved ON abuse_reports(resolvedAt)');
  // Serves both listReportSummaries' per-relayId GROUP BY (filtered on
  // resolvedAt IS NULL) and getReportsForRelayId's per-target ORDER BY
  // createdAt — without this, both queries were a full table scan, fine at
  // launch volume but not once a report spike (organic or a brigade) pushes
  // this table into the tens of thousands of rows.
  await db.execute('CREATE INDEX IF NOT EXISTS idx_abuse_reports_resolved_target_created ON abuse_reports(resolvedAt, targetRelayId, createdAt)');

  // Permanent ban tombstones — deliberately separate from the users table.
  // deleteUser() (called by an operator ban) only deletes that row; relayId
  // is deterministically derived from the account's public key
  // (lib/crypto/relay-id.ts) and the client's local keypair is untouched by
  // a server-side ban, so without this table the exact same signup request
  // could simply be replayed to get the identical relayId back — fully
  // undoing a ban the Terms describe as "permanent." Rows here are never
  // deleted by application code.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS banned_relay_ids (
      relayId TEXT PRIMARY KEY,
      bannedAt INTEGER NOT NULL
    )
  `);

  // Append-only log of "an admin confirmed the six statements on
  // /legal/canary were still true, at this exact timestamp" — see
  // lib/db/canary-db.ts. This replaced a hand-edited, PGP-signed-commit
  // process (lib/legal/canary-schedule.ts, now removed); only the latest row
  // matters for display, but nothing is ever deleted so the confirmation
  // history stays auditable.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS canary_confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      confirmedAt INTEGER NOT NULL,
      confirmedBy TEXT NOT NULL
    )
  `);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_canary_confirmations_confirmedAt ON canary_confirmations(confirmedAt DESC)');
  // Seed one historical row so this cutover from the old static-file process
  // doesn't make a fresh deploy show "never confirmed" (and immediately
  // overdue) on first boot — 2026-07-23 is the last date the canary was
  // actually re-verified true under the prior process, before this table
  // became the source of truth.
  const canarySeedCheck = await db.execute('SELECT COUNT(*) as c FROM canary_confirmations');
  if (Number(canarySeedCheck.rows[0]?.c ?? 0) === 0) {
    await db.execute({
      sql: 'INSERT INTO canary_confirmations (confirmedAt, confirmedBy) VALUES (?, ?)',
      args: [Date.parse('2026-07-23T00:00:00Z'), 'migration-seed'],
    });
  }

  // Redacted legal-process records an admin has chosen to publish to
  // /legal/transparency (see lib/db/canary-db.ts). The actual PDF bytes live
  // on disk (lib/legal/legal-request-files.ts) — pdfFilename here is always
  // a server-generated UUID, never a client-supplied string, so this table
  // never stores anything that could be used for a path-traversal lookup.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS legal_requests (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      receivedAt INTEGER NOT NULL,
      notes TEXT,
      pdfFilename TEXT NOT NULL,
      createdBy TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_legal_requests_receivedAt ON legal_requests(receivedAt DESC)');
}

// Retry defense against a genuinely SEPARATE OS process (the relay-node.ts
// server, via lib/db/session-store.ts,
// also calls getDb()) racing this process's migration on a brand-new,
// never-migrated database file — the globalThis anchor above only
// deduplicates instances WITHIN one process, it can't coordinate across
// two real processes. BEGIN IMMEDIATE (in runMigrations) takes a real write
// lock for the whole migration, so the losing process gets a clean
// SQLITE_BUSY to retry here instead of two DDL streams interleaving.
const MIGRATION_MAX_RETRIES = 6;
const MIGRATION_BASE_DELAY_MS = 25;

/** Returns the shared libSQL client, running schema migrations exactly once per resolved URL/process. */
export async function getDb(): Promise<Client> {
  const db = getClient();
  const url = resolveUrl();
  if (!globalForDb.__relayDbMigrations) globalForDb.__relayDbMigrations = new Map();
  const migrations = globalForDb.__relayDbMigrations;
  if (!migrations.get(url)) {
    migrations.set(
      url,
      (async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            await runMigrations(db);
            return;
          } catch (err) {
            const isBusy = err instanceof LibsqlError && err.code === 'SQLITE_BUSY';
            if (!isBusy || attempt >= MIGRATION_MAX_RETRIES) throw err;
            const delay = MIGRATION_BASE_DELAY_MS * 2 ** attempt + Math.random() * MIGRATION_BASE_DELAY_MS;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      })().catch((err) => {
        // Without this, a transient migration failure (disk hiccup, unmounted
        // volume on cold start, or retries exhausted above) leaves this
        // permanently set to a rejected promise — every future getDb() call
        // for this URL immediately re-throws the SAME stale error forever,
        // with no way to recover short of a manual restart, even once the
        // underlying issue clears. Reset so the next call retries migrations
        // from scratch.
        migrations.delete(url);
        throw err;
      })
    );
  }
  await migrations.get(url);
  return db;
}

const WRITE_TX_MAX_RETRIES = 6;
const WRITE_TX_BASE_DELAY_MS = 25;

/**
 * Run `fn` inside a fresh write transaction, retrying the WHOLE thing
 * (begin + fn + any commit fn performs) from scratch on SQLITE_BUSY.
 *
 * Deliberately NOT implemented via SQLite's native `busy_timeout` pragma —
 * verified empirically that its retry loop blocks synchronously inside the
 * native driver, freezing this entire Node.js process's event loop (every
 * other in-flight request, WS heartbeat, everything) for the full timeout
 * on any write/write lock contention. That's worse than today's instant-fail
 * behavior, not better. This retries at the JS layer instead: each backoff
 * delay is a real `setTimeout`-based await that yields the event loop back
 * to every other pending request between attempts, and a fresh transaction
 * is started per attempt (SQLite has no way to "resume" a failed one).
 *
 * `fn` must call `tx.commit()` itself (some callers commit early on a
 * no-op/not-found path without ever writing) — this wrapper only owns
 * retry and `tx.close()`, matching the existing call sites' shape.
 */
export async function runWriteTransaction<T>(
  db: Client,
  fn: (tx: Transaction) => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    // `db.transaction('write')` itself — not just fn(tx) — is precisely the
    // call that issues BEGIN IMMEDIATE and throws SQLITE_BUSY under write
    // contention (no busy_timeout pragma is set; see this function's own
    // doc comment for why). It used to sit outside this try block, so a
    // busy failure on ACQUIRING the transaction propagated straight past
    // the retry/backoff logic below as an unhandled 500 — for every retry
    // attempt, not just the first, since a fresh acquisition is attempted
    // each time. Moved inside so both failure points are retried alike.
    let tx: Transaction | undefined;
    try {
      tx = await db.transaction('write');
      return await fn(tx);
    } catch (err) {
      const isBusy = err instanceof LibsqlError && err.code === 'SQLITE_BUSY';
      if (!isBusy || attempt >= WRITE_TX_MAX_RETRIES) throw err;
      const delay = WRITE_TX_BASE_DELAY_MS * 2 ** attempt + Math.random() * WRITE_TX_BASE_DELAY_MS;
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      tx?.close();
    }
  }
}
