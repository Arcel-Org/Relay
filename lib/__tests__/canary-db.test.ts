/**
 * @vitest-environment node
 *
 * Coverage for lib/db/canary-db.ts against a real throwaway on-disk SQLite
 * DB (same pattern as abuse-reports-db.test.ts). Covers the migration seed,
 * confirmation recording/status computation (overdue/dueSoon), and the
 * legal-request record CRUD + its public/admin field-stripping split.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-canary-db-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64);
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('canary confirmations', () => {
  it('seeds one historical confirmation row on a fresh DB', async () => {
    const { getLatestCanaryConfirmation } = await import('../db/canary-db');
    const latest = await getLatestCanaryConfirmation();
    expect(latest).not.toBeNull();
    expect(latest!.confirmedBy).toBe('migration-seed');
    expect(latest!.confirmedAt).toBe(Date.parse('2026-07-23T00:00:00Z'));
  });

  it('recordCanaryConfirmation stamps the current time and becomes the latest row', async () => {
    const { recordCanaryConfirmation, getLatestCanaryConfirmation } = await import('../db/canary-db');
    const before = Date.now();
    const result = await recordCanaryConfirmation('admin-relay-1');
    const after = Date.now();

    expect(result.confirmedBy).toBe('admin-relay-1');
    expect(result.confirmedAt).toBeGreaterThanOrEqual(before);
    expect(result.confirmedAt).toBeLessThanOrEqual(after);

    const latest = await getLatestCanaryConfirmation();
    expect(latest).toEqual(result);
  });

  it('getCanaryStatus flags overdue once the cadence window has passed', async () => {
    const { recordCanaryConfirmation, getCanaryStatus } = await import('../db/canary-db');
    // recordCanaryConfirmation always stamps "now" — insert directly via
    // getDb instead, to control the confirmedAt timestamp precisely. Clear
    // the migration-seeded row first: its fixed 2026-07-23 date could
    // otherwise outrank a relative "40 days ago" depending on the real
    // wall-clock date the test happens to run on, making this flaky.
    const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000; // well past the 30-day cadence
    const { getDb } = await import('../db/sqlite-client');
    const db = await getDb();
    await db.execute('DELETE FROM canary_confirmations');
    await db.execute({
      sql: 'INSERT INTO canary_confirmations (confirmedAt, confirmedBy) VALUES (?, ?)',
      args: [fortyDaysAgo, 'admin-relay-1'],
    });

    const status = await getCanaryStatus();
    expect(status!.confirmedAt).toBe(fortyDaysAgo);
    expect(status!.overdue).toBe(true);
    expect(status!.dueSoon).toBe(true); // overdue implies dueSoon

    await recordCanaryConfirmation('admin-relay-2');
    const fresh = await getCanaryStatus();
    expect(fresh!.overdue).toBe(false);
    expect(fresh!.dueSoon).toBe(false);
  });

  it('getCanaryStatus counts legal requests received since the last confirmation', async () => {
    const { recordCanaryConfirmation, getCanaryStatus, insertLegalRequest } = await import('../db/canary-db');
    const confirmation = await recordCanaryConfirmation('admin-relay-1');

    await insertLegalRequest({
      title: 'Subpoena before confirmation',
      category: 'other',
      receivedAt: confirmation.confirmedAt - 1000,
      pdfFilename: 'before.pdf',
      createdBy: 'admin-relay-1',
    });
    await insertLegalRequest({
      title: 'Subpoena after confirmation',
      category: 'search_warrant',
      receivedAt: confirmation.confirmedAt + 1000,
      pdfFilename: 'after.pdf',
      createdBy: 'admin-relay-1',
    });

    const status = await getCanaryStatus();
    expect(status!.legalRequestsSinceConfirmation).toBe(1);
  });
});

describe('legal request records', () => {
  it('round-trips a full record through the admin (unstripped) view', async () => {
    const { insertLegalRequest, listLegalRequests, getLegalRequestById } = await import('../db/canary-db');
    const record = await insertLegalRequest({
      title: 'Grand jury subpoena',
      category: 'grand_jury_subpoena',
      receivedAt: Date.now(),
      notes: 'internal case note',
      pdfFilename: 'abc123.pdf',
      createdBy: 'admin-relay-1',
    });

    const byId = await getLegalRequestById(record.id);
    expect(byId).toEqual(record);

    const list = await listLegalRequests();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(record);
  });

  it('strips notes, createdBy, and pdfFilename from the public view', async () => {
    const { insertLegalRequest, listPublicLegalRequests } = await import('../db/canary-db');
    await insertLegalRequest({
      title: 'FISA order',
      category: 'fisa_order',
      receivedAt: Date.now(),
      notes: 'should never reach the public',
      pdfFilename: 'secret-filename.pdf',
      createdBy: 'admin-relay-1',
    });

    const [publicRecord] = await listPublicLegalRequests();
    expect(publicRecord.title).toBe('FISA order');
    expect(publicRecord.category).toBe('fisa_order');
    const keys = Object.keys(publicRecord);
    expect(keys).not.toContain('notes');
    expect(keys).not.toContain('createdBy');
    expect(keys).not.toContain('pdfFilename');
  });

  it('orders records most-recently-received first', async () => {
    const { insertLegalRequest, listLegalRequests } = await import('../db/canary-db');
    const now = Date.now();
    await insertLegalRequest({ title: 'Older', category: 'other', receivedAt: now - 10_000, pdfFilename: 'a.pdf', createdBy: 'x' });
    await insertLegalRequest({ title: 'Newer', category: 'other', receivedAt: now, pdfFilename: 'b.pdf', createdBy: 'x' });

    const list = await listLegalRequests();
    expect(list.map((r) => r.title)).toEqual(['Newer', 'Older']);
  });

  it('deleteLegalRequest removes the row and returns the deleted record; returns null for an unknown id', async () => {
    const { insertLegalRequest, deleteLegalRequest, getLegalRequestById } = await import('../db/canary-db');
    const record = await insertLegalRequest({
      title: 'To be deleted', category: 'other', receivedAt: Date.now(), pdfFilename: 'x.pdf', createdBy: 'admin-relay-1',
    });

    const deleted = await deleteLegalRequest(record.id);
    expect(deleted).toEqual(record);
    expect(await getLegalRequestById(record.id)).toBeNull();
    expect(await deleteLegalRequest(record.id)).toBeNull();
    expect(await deleteLegalRequest('never-existed')).toBeNull();
  });
});
