/**
 * @vitest-environment node
 *
 * Coverage for abuse-reports-db.ts against a real throwaway on-disk SQLite
 * DB (same pattern as public-groups-db.test.ts). Covers insert, per-relayId
 * aggregate summaries (count/category breakdown/clustering), resolution,
 * and — the whole point of this table's design — that no reporter identity
 * is ever stored anywhere in it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-abuse-reports-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64);
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('insertReport / getReportsForRelayId', () => {
  it('stores a report with no reporter-identity field of any kind', async () => {
    const { insertReport, getReportsForRelayId } = await import('../db/abuse-reports-db');
    await insertReport({ targetRelayId: 'target-1', category: 'spam', note: 'unsolicited invites' });

    const { reports, totalCount } = await getReportsForRelayId('target-1');
    expect(reports).toHaveLength(1);
    expect(totalCount).toBe(1);
    expect(reports[0].targetRelayId).toBe('target-1');
    expect(reports[0].category).toBe('spam');
    expect(reports[0].note).toBe('unsolicited invites');
    // The entire design point of this table: assert no key on the returned
    // record could ever identify who filed the report.
    const keys = Object.keys(reports[0]);
    expect(keys.some((k) => /report(er)?/i.test(k) && k !== 'targetRelayId')).toBe(false);
  });

  it('orders reports oldest-first for one relayId', async () => {
    const { insertReport, getReportsForRelayId } = await import('../db/abuse-reports-db');
    await insertReport({ targetRelayId: 'target-1', category: 'spam' });
    await insertReport({ targetRelayId: 'target-1', category: 'harassment' });

    const { reports } = await getReportsForRelayId('target-1');
    expect(reports.map((r) => r.category)).toEqual(['spam', 'harassment']);
  });

  it('note is omitted (not stored as empty string) when not provided', async () => {
    const { insertReport, getReportsForRelayId } = await import('../db/abuse-reports-db');
    await insertReport({ targetRelayId: 'target-1', category: 'other' });
    const { reports } = await getReportsForRelayId('target-1');
    expect(reports[0].note).toBeUndefined();
  });

  it('caps returned reports at `limit` but still reports the true totalCount, oldest-of-the-recent-page first', async () => {
    const { insertReport, getReportsForRelayId } = await import('../db/abuse-reports-db');
    for (let i = 0; i < 10; i++) {
      await insertReport({ targetRelayId: 'target-brigaded', category: 'spam', note: `note${i}` });
    }

    const { reports, totalCount } = await getReportsForRelayId('target-brigaded', 3);
    expect(totalCount).toBe(10);
    expect(reports).toHaveLength(3);
    // Capped to the 3 MOST RECENT (note7,note8,note9), returned oldest-first among those.
    expect(reports.map((r) => r.note)).toEqual(['note7', 'note8', 'note9']);
  });
});

describe('listReportSummaries', () => {
  it('groups unresolved reports per relayId with a category breakdown', async () => {
    const { insertReport, listReportSummaries } = await import('../db/abuse-reports-db');
    await insertReport({ targetRelayId: 'target-1', category: 'spam' });
    await insertReport({ targetRelayId: 'target-1', category: 'spam' });
    await insertReport({ targetRelayId: 'target-1', category: 'harassment' });
    await insertReport({ targetRelayId: 'target-2', category: 'other' });

    const { summaries, totalCount } = await listReportSummaries();
    expect(summaries).toHaveLength(2);
    expect(totalCount).toBe(2);

    const target1 = summaries.find((s) => s.targetRelayId === 'target-1')!;
    expect(target1.count).toBe(3);
    expect(target1.categoryBreakdown).toEqual({ spam: 2, harassment: 1 });
  });

  it('sorts by report count descending', async () => {
    const { insertReport, listReportSummaries } = await import('../db/abuse-reports-db');
    await insertReport({ targetRelayId: 'target-few', category: 'spam' });
    await insertReport({ targetRelayId: 'target-many', category: 'spam' });
    await insertReport({ targetRelayId: 'target-many', category: 'spam' });
    await insertReport({ targetRelayId: 'target-many', category: 'spam' });

    const { summaries } = await listReportSummaries();
    expect(summaries[0].targetRelayId).toBe('target-many');
    expect(summaries[0].count).toBe(3);
  });

  it('excludes resolved reports from the summary entirely', async () => {
    const { insertReport, resolveReports, listReportSummaries } = await import('../db/abuse-reports-db');
    await insertReport({ targetRelayId: 'target-1', category: 'spam' });
    await resolveReports('target-1', 'dismissed');

    const { summaries } = await listReportSummaries();
    expect(summaries.find((s) => s.targetRelayId === 'target-1')).toBeUndefined();
  });

  it('flags a relayId as clustered when >=5 reports land within a 10-minute window', async () => {
    vi.resetModules();
    const realNow = Date.now;
    let fakeNow = 1_000_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    try {
      const { insertReport, listReportSummaries } = await import('../db/abuse-reports-db');
      // 5 reports 30s apart — well inside the 10-minute clustering window.
      for (let i = 0; i < 5; i++) {
        await insertReport({ targetRelayId: 'target-brigaded', category: 'harassment' });
        fakeNow += 30_000;
      }
      const { summaries } = await listReportSummaries();
      const target = summaries.find((s) => s.targetRelayId === 'target-brigaded')!;
      expect(target.clustered).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it('does not flag reports spread far apart as clustered', async () => {
    vi.resetModules();
    const realNow = Date.now;
    let fakeNow = 1_000_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    try {
      const { insertReport, listReportSummaries } = await import('../db/abuse-reports-db');
      for (let i = 0; i < 5; i++) {
        await insertReport({ targetRelayId: 'target-organic', category: 'harassment' });
        fakeNow += 60 * 60 * 1000; // 1 hour apart
      }
      const { summaries } = await listReportSummaries();
      const target = summaries.find((s) => s.targetRelayId === 'target-organic')!;
      expect(target.clustered).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it('paginates at the relayId-group level — a page boundary never splits one relayId across two pages', async () => {
    const { insertReport, listReportSummaries } = await import('../db/abuse-reports-db');
    // 3 distinct relayIds, each with a different report count so sort order is deterministic.
    for (let i = 0; i < 5; i++) await insertReport({ targetRelayId: 'target-most', category: 'spam' });
    for (let i = 0; i < 3; i++) await insertReport({ targetRelayId: 'target-mid', category: 'spam' });
    for (let i = 0; i < 1; i++) await insertReport({ targetRelayId: 'target-least', category: 'spam' });

    const page1 = await listReportSummaries({ limit: 2, offset: 0 });
    expect(page1.totalCount).toBe(3);
    expect(page1.summaries.map((s) => s.targetRelayId)).toEqual(['target-most', 'target-mid']);
    // Every report for 'target-mid' must be present on this page, not split.
    expect(page1.summaries.find((s) => s.targetRelayId === 'target-mid')!.count).toBe(3);

    const page2 = await listReportSummaries({ limit: 2, offset: 2 });
    expect(page2.summaries.map((s) => s.targetRelayId)).toEqual(['target-least']);
  });

  it('relayIds tied on report count still produce a stable, non-overlapping page split (targetRelayId ASC tiebreaker)', async () => {
    const { insertReport, listReportSummaries } = await import('../db/abuse-reports-db');
    // 4 relayIds, all tied at 2 reports each, inserted out of alphabetical
    // order — the ORDER BY's targetRelayId ASC tiebreaker is what this
    // asserts on; without it the query relies on SQLite's own unspecified
    // GROUP BY tie order (which happens to already sort by the grouped
    // column in this engine's current implementation, so this doesn't
    // actually fail without the tiebreaker — it documents the guarantee
    // going forward rather than catching a live regression).
    for (const id of ['target-d', 'target-b', 'target-a', 'target-c']) {
      await insertReport({ targetRelayId: id, category: 'spam' });
      await insertReport({ targetRelayId: id, category: 'spam' });
    }

    const page1 = await listReportSummaries({ limit: 2, offset: 0 });
    const page2 = await listReportSummaries({ limit: 2, offset: 2 });

    expect(page1.summaries.map((s) => s.targetRelayId)).toEqual(['target-a', 'target-b']);
    expect(page2.summaries.map((s) => s.targetRelayId)).toEqual(['target-c', 'target-d']);
    const combined = [...page1.summaries, ...page2.summaries].map((s) => s.targetRelayId);
    expect(new Set(combined).size).toBe(4);
  });

  it('returns an empty page (not an error) past the end of the data', async () => {
    const { insertReport, listReportSummaries } = await import('../db/abuse-reports-db');
    await insertReport({ targetRelayId: 'target-1', category: 'spam' });

    const { summaries, totalCount } = await listReportSummaries({ limit: 10, offset: 50 });
    expect(summaries).toEqual([]);
    expect(totalCount).toBe(1);
  });
});

describe('resolveReports', () => {
  it('marks all of a relayId\'s unresolved reports with the given resolution', async () => {
    const { insertReport, resolveReports, getReportsForRelayId } = await import('../db/abuse-reports-db');
    await insertReport({ targetRelayId: 'target-1', category: 'spam' });
    await insertReport({ targetRelayId: 'target-1', category: 'harassment' });

    await resolveReports('target-1', 'banned');

    const { reports } = await getReportsForRelayId('target-1');
    expect(reports.every((r) => r.resolution === 'banned')).toBe(true);
    expect(reports.every((r) => typeof r.resolvedAt === 'number')).toBe(true);
  });

  it('is idempotent — resolving with no unresolved reports is a harmless no-op', async () => {
    const { resolveReports } = await import('../db/abuse-reports-db');
    await expect(resolveReports('no-such-target', 'dismissed')).resolves.toBeUndefined();
  });

  it('does not touch other relayIds\' reports', async () => {
    const { insertReport, resolveReports, getReportsForRelayId } = await import('../db/abuse-reports-db');
    await insertReport({ targetRelayId: 'target-1', category: 'spam' });
    await insertReport({ targetRelayId: 'target-2', category: 'spam' });

    await resolveReports('target-1', 'banned');

    const { reports: target2 } = await getReportsForRelayId('target-2');
    expect(target2[0].resolution).toBeUndefined();
  });
});

describe('listRecentResolutions', () => {
  it('returns only resolved reports, most-recently-resolved first', async () => {
    vi.resetModules();
    const realNow = Date.now;
    let fakeNow = 1_000_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    try {
      const { insertReport, resolveReports, listRecentResolutions } = await import('../db/abuse-reports-db');
      await insertReport({ targetRelayId: 'target-1', category: 'spam' });
      fakeNow += 1000;
      await resolveReports('target-1', 'dismissed');
      fakeNow += 1000;
      await insertReport({ targetRelayId: 'target-2', category: 'harassment' });
      fakeNow += 1000;
      await resolveReports('target-2', 'banned');
      // Left unresolved on purpose — must not appear in the audit trail.
      await insertReport({ targetRelayId: 'target-3', category: 'other' });

      const recent = await listRecentResolutions(10);
      expect(recent.map((r) => r.targetRelayId)).toEqual(['target-2', 'target-1']);
      expect(recent.every((r) => typeof r.resolvedAt === 'number')).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it('caps results at the given limit', async () => {
    const { insertReport, resolveReports, listRecentResolutions } = await import('../db/abuse-reports-db');
    for (let i = 0; i < 5; i++) {
      await insertReport({ targetRelayId: `target-${i}`, category: 'spam' });
      await resolveReports(`target-${i}`, 'dismissed');
    }

    const recent = await listRecentResolutions(2);
    expect(recent).toHaveLength(2);
  });

  it('returns an empty array when nothing has been resolved yet', async () => {
    const { insertReport, listRecentResolutions } = await import('../db/abuse-reports-db');
    await insertReport({ targetRelayId: 'target-1', category: 'spam' });

    expect(await listRecentResolutions(10)).toEqual([]);
  });
});
