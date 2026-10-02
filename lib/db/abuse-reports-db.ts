/**
 * Abuse reports — aggregate-only abuse queue for the platform operator.
 *
 * Deliberately stores NO reporter identity (see the table's comment in
 * sqlite-client.ts) and NEVER auto-bans on report volume: a raw report count
 * is trivially gamed by a phone farm / sock-puppet cluster, so any
 * threshold-triggered action would just hand attackers a griefing tool. A
 * human (the operator) reviews the queue and decides per relayId; this
 * module only aggregates for that review, it never acts on its own.
 */
import { getDb, runWriteTransaction } from './sqlite-client';
import type { Row } from '@libsql/client';

export type ReportCategory = 'spam' | 'harassment' | 'csam' | 'other';
export const REPORT_CATEGORIES: ReportCategory[] = ['spam', 'harassment', 'csam', 'other'];

export interface AbuseReportRecord {
  id: number;
  targetRelayId: string;
  category: ReportCategory;
  note?: string;
  createdAt: number;
  resolvedAt?: number;
  resolution?: 'banned' | 'dismissed';
}

/**
 * A relayId's unresolved reports need >= this many hits inside
 * CLUSTER_WINDOW_MS for the dashboard to flag them as clustered — the
 * signature of a coordinated mass-report (many reports in a burst) rather
 * than organic, independent reports trickling in over time. Purely
 * informational for the operator's own judgment call; never drives any
 * automatic action.
 */
const CLUSTER_WINDOW_MS = 10 * 60 * 1000;
const CLUSTER_MIN_COUNT = 5;

export interface ReportSummary {
  targetRelayId: string;
  count: number;
  categoryBreakdown: Record<string, number>;
  firstAt: number;
  lastAt: number;
  clustered: boolean;
}

function rowToReport(row: Row): AbuseReportRecord {
  return {
    id: Number(row.id),
    targetRelayId: row.targetRelayId as string,
    category: row.category as ReportCategory,
    note: (row.note as string) || undefined,
    createdAt: Number(row.createdAt),
    resolvedAt: row.resolvedAt != null ? Number(row.resolvedAt) : undefined,
    resolution: (row.resolution as 'banned' | 'dismissed') || undefined,
  };
}

/** True if any CLUSTER_MIN_COUNT-sized window of `timestamps` spans <= CLUSTER_WINDOW_MS. */
function detectCluster(timestampsAsc: number[]): boolean {
  if (timestampsAsc.length < CLUSTER_MIN_COUNT) return false;
  for (let i = 0; i + CLUSTER_MIN_COUNT - 1 < timestampsAsc.length; i++) {
    if (timestampsAsc[i + CLUSTER_MIN_COUNT - 1] - timestampsAsc[i] <= CLUSTER_WINDOW_MS) return true;
  }
  return false;
}

export async function insertReport(params: {
  targetRelayId: string;
  category: ReportCategory;
  note?: string;
}): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'INSERT INTO abuse_reports (targetRelayId, category, note, createdAt) VALUES (?, ?, ?, ?)',
    args: [params.targetRelayId, params.category, params.note ?? null, Date.now()],
  });
}

const DEFAULT_REPORTS_PER_TARGET_LIMIT = 100;

/**
 * Ordered (oldest first) report rows for one relayId, capped at `limit` —
 * without a cap, expanding a heavily-reported (or brigaded — see
 * detectCluster) relayId in the admin dashboard fetched and rendered every
 * report ever filed against it, right when the operator most needs a fast
 * triage view rather than a multi-thousand-row dump. `totalCount` reports
 * how many exist in total (including resolved) so the operator can tell
 * when they're looking at a truncated view.
 */
export async function getReportsForRelayId(
  targetRelayId: string,
  limit: number = DEFAULT_REPORTS_PER_TARGET_LIMIT
): Promise<{ reports: AbuseReportRecord[]; totalCount: number }> {
  const db = await getDb();
  const [pageResult, countResult] = await Promise.all([
    db.execute({
      // Fetch the most recent `limit` rows, then reverse to oldest-first
      // for display — ORDER BY createdAt ASC LIMIT would instead return
      // the OLDEST rows first when capped, which is the least useful page
      // for an operator triaging an active situation. `id DESC` breaks ties
      // when several reports land in the same millisecond (id is an
      // autoincrement PK, so it's a reliable insertion-order tiebreaker) —
      // without it, SQLite's tie order is unspecified and reversing it
      // could scramble same-timestamp reports out of insertion order.
      sql: 'SELECT * FROM abuse_reports WHERE targetRelayId = ? ORDER BY createdAt DESC, id DESC LIMIT ?',
      args: [targetRelayId, limit],
    }),
    db.execute({
      sql: 'SELECT COUNT(*) as count FROM abuse_reports WHERE targetRelayId = ?',
      args: [targetRelayId],
    }),
  ]);
  const reports = pageResult.rows.map(rowToReport).reverse();
  const totalCount = Number(countResult.rows[0]?.count ?? 0);
  return { reports, totalCount };
}

const DEFAULT_SUMMARIES_LIMIT = 50;

/**
 * Per-relayId aggregate view of UNRESOLVED reports only, for the admin
 * queue — paginated at the relayId-group level (not the raw-row level, so
 * a page boundary never splits one relayId's reports across two pages).
 * Sorted by report count descending, since that's the operator's most
 * likely starting point, with targetRelayId ASC as a tiebreaker — without
 * a deterministic tiebreak, relayIds tied on cnt have no defined order
 * across separate paginated calls, so a page boundary could split or
 * duplicate a tied group between page N and N+1. Returns `totalCount`
 * (total distinct flagged relayIds) so the dashboard can show "showing 50
 * of N" rather than silently truncating.
 */
export async function listReportSummaries(
  opts: { limit?: number; offset?: number } = {}
): Promise<{ summaries: ReportSummary[]; totalCount: number }> {
  const limit = opts.limit ?? DEFAULT_SUMMARIES_LIMIT;
  const offset = opts.offset ?? 0;
  const db = await getDb();

  const [pageOfTargetsResult, totalCountResult] = await Promise.all([
    db.execute({
      sql: `
        SELECT targetRelayId, COUNT(*) as cnt
        FROM abuse_reports
        WHERE resolvedAt IS NULL
        GROUP BY targetRelayId
        ORDER BY cnt DESC, targetRelayId ASC
        LIMIT ? OFFSET ?
      `,
      args: [limit, offset],
    }),
    db.execute(
      'SELECT COUNT(DISTINCT targetRelayId) as count FROM abuse_reports WHERE resolvedAt IS NULL'
    ),
  ]);
  const totalCount = Number(totalCountResult.rows[0]?.count ?? 0);
  const targetIds = pageOfTargetsResult.rows.map((r) => r.targetRelayId as string);
  if (targetIds.length === 0) return { summaries: [], totalCount };

  // One batched fetch for every relayId on this page's reports, rather than
  // one query per relayId — the placeholders are safe (not user input
  // concatenated into SQL; each is bound as its own arg).
  const placeholders = targetIds.map(() => '?').join(', ');
  const reportsResult = await db.execute({
    sql: `SELECT * FROM abuse_reports WHERE resolvedAt IS NULL AND targetRelayId IN (${placeholders}) ORDER BY targetRelayId, createdAt ASC, id ASC`,
    args: targetIds,
  });

  const byTarget = new Map<string, AbuseReportRecord[]>();
  for (const row of reportsResult.rows) {
    const report = rowToReport(row);
    const existing = byTarget.get(report.targetRelayId);
    if (existing) existing.push(report);
    else byTarget.set(report.targetRelayId, [report]);
  }

  const summaries: ReportSummary[] = targetIds.map((targetRelayId) => {
    const reports = byTarget.get(targetRelayId) ?? [];
    const categoryBreakdown: Record<string, number> = {};
    for (const r of reports) categoryBreakdown[r.category] = (categoryBreakdown[r.category] || 0) + 1;
    const timestamps = reports.map((r) => r.createdAt);
    return {
      targetRelayId,
      count: reports.length,
      categoryBreakdown,
      firstAt: timestamps[0],
      lastAt: timestamps[timestamps.length - 1],
      clustered: detectCluster(timestamps),
    };
  });
  return { summaries, totalCount };
}

/**
 * Mark every currently-unresolved report against targetRelayId with the
 * given resolution ('banned' after an operator ban, 'dismissed' otherwise).
 * Idempotent — resolving a relayId with no unresolved reports is a no-op.
 */
export async function resolveReports(
  targetRelayId: string,
  resolution: 'banned' | 'dismissed'
): Promise<void> {
  const db = await getDb();
  await runWriteTransaction(db, async (tx) => {
    await tx.execute({
      sql: 'UPDATE abuse_reports SET resolvedAt = ?, resolution = ? WHERE targetRelayId = ? AND resolvedAt IS NULL',
      args: [Date.now(), resolution, targetRelayId],
    });
    await tx.commit();
  });
}

/**
 * The operator's own audit trail: the most recent resolved reports (one row
 * per report, not grouped by relayId — so a relayId resolved with 3 reports
 * at once shows as 3 rows here, each with the same resolvedAt/resolution).
 * Most-recent first.
 */
export async function listRecentResolutions(limit: number): Promise<AbuseReportRecord[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM abuse_reports WHERE resolvedAt IS NOT NULL ORDER BY resolvedAt DESC LIMIT ?',
    args: [limit],
  });
  return result.rows.map(rowToReport);
}
