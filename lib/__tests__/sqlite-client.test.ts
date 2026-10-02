/**
 * @vitest-environment node
 *
 * Runs the actual schema migration (lib/db/sqlite-client.ts) against a
 * throwaway on-disk DB. Purely mechanical — CREATE TABLE/INDEX statements
 * have no test coverage otherwise, and a broken migration (bad SQL, a
 * template-literal quoting bug, etc.) only surfaces at first real request
 * in production. Also locks in that the case-insensitive-lookup expression
 * indexes actually exist, since a plain column index silently fails to
 * accelerate a lower(col)=? query with no error — see relay-server-db.ts's
 * getUserByUsername() and public-groups-db.ts's findByHandle().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-sqlite-migration-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64);
  // sqlite-client caches its client/migration state at module scope — reset
  // so each test gets a fresh module instance bound to its own DATA_DIR
  // instead of silently reusing the previous test's already-migrated DB.
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('sqlite-client migration', () => {
  it('runs the full schema migration without throwing', async () => {
    const { getDb } = await import('../db/sqlite-client');
    await expect(getDb()).resolves.toBeDefined();
  });

  it('creates the expression indexes case-insensitive lookups depend on', async () => {
    const { getDb } = await import('../db/sqlite-client');
    const db = await getDb();
    const result = await db.execute("SELECT name FROM sqlite_master WHERE type = 'index'");
    const indexNames = result.rows.map((r: any) => r.name);
    expect(indexNames).toContain('idx_users_username_lower');
    expect(indexNames).toContain('idx_public_groups_handle_lower');
    expect(indexNames).toContain('idx_users_shortcode_lower');
  });
});

describe('runWriteTransaction — retries SQLITE_BUSY from transaction ACQUISITION, not just from fn()', () => {
  // db.transaction('write') issues BEGIN IMMEDIATE and is precisely where a
  // SQLITE_BUSY under write contention actually surfaces — this used to sit
  // outside the try/catch, so it propagated straight past the retry loop as
  // an unhandled error instead of being retried like any other busy error.
  function makeFakeDb(transactionImpl: () => Promise<any>) {
    return { transaction: vi.fn(transactionImpl) } as any;
  }

  it('retries and succeeds when transaction() itself throws SQLITE_BUSY on the first attempt', async () => {
    const { runWriteTransaction } = await import('../db/sqlite-client');
    const { LibsqlError } = await import('@libsql/client');

    let calls = 0;
    const fakeTx = { close: vi.fn() };
    const db = makeFakeDb(async () => {
      calls += 1;
      if (calls === 1) throw new LibsqlError('database is locked', 'SQLITE_BUSY');
      return fakeTx;
    });

    const result = await runWriteTransaction(db, async (tx) => {
      expect(tx).toBe(fakeTx);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it('does not retry (rethrows immediately) when transaction() throws a non-busy error', async () => {
    const { runWriteTransaction } = await import('../db/sqlite-client');
    const { LibsqlError } = await import('@libsql/client');

    const db = makeFakeDb(async () => {
      throw new LibsqlError('syntax error', 'SQLITE_ERROR');
    });

    await expect(runWriteTransaction(db, async () => 'unreachable')).rejects.toThrow('SQLITE_ERROR');
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('does not call tx.close() on an attempt where transaction() itself failed (tx was never created)', async () => {
    const { runWriteTransaction } = await import('../db/sqlite-client');
    const { LibsqlError } = await import('@libsql/client');

    const fakeTx = { close: vi.fn() };
    let calls = 0;
    const db = makeFakeDb(async () => {
      calls += 1;
      if (calls === 1) throw new LibsqlError('database is locked', 'SQLITE_BUSY');
      return fakeTx;
    });

    await runWriteTransaction(db, async () => 'ok');

    // Only the successful second attempt's real tx should ever be closed.
    expect(fakeTx.close).toHaveBeenCalledTimes(1);
  });
});
