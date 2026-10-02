'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronDown, ShieldAlert, Ban, XCircle, History, AlertTriangle } from 'lucide-react';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import type { ReportSummary, AbuseReportRecord } from '@/lib/db/abuse-reports-db';

interface AccountInfo {
  relayId: string;
  displayName: string | null;
  username: string | null;
  createdAt: number;
  lastLogin: number | null;
}

interface DetailEntry {
  reports: AbuseReportRecord[];
  totalCount: number;
  account: AccountInfo | null;
}

const PAGE_SIZE = 50;

/** 429s share one message everywhere on this page rather than falling through to a generic "failed" string. */
function messageForResponse(res: Response, fallback: string): string {
  return res.status === 429 ? 'Rate limited — wait a moment and try again.' : fallback;
}

/**
 * Abuse-report review queue — operator-only (server enforces this via
 * requireAdmin regardless of what this page renders; a non-admin who
 * navigates here just sees the "Not authorized" state below once the fetch
 * 403s). Reports are aggregate-only (no reporter identity — see
 * abuse-reports-db.ts) and nothing here bans automatically: every action is
 * a deliberate click by whoever holds ADMIN_RELAY_IDS.
 */
export default function AdminReportsPage() {
  const router = useRouter();
  const { flow } = useRelayAuthStoreV2();
  const [summaries, setSummaries] = useState<ReportSummary[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, DetailEntry>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);

  const [showResolved, setShowResolved] = useState(false);
  const [resolved, setResolved] = useState<AbuseReportRecord[] | null>(null);
  const [resolvedLoading, setResolvedLoading] = useState(false);

  // Purely a nav badge — surfaced here too (not just on /app/admin/canary
  // itself) so the operator notices an overdue canary confirmation without
  // having to remember to check a second page. Failure to load this is
  // non-fatal to the rest of the page, so errors are swallowed.
  const [canaryNeedsAttention, setCanaryNeedsAttention] = useState(false);

  useEffect(() => {
    if (flow !== 'authenticated') {
      router.push('/auth/login');
    }
  }, [flow, router]);

  useEffect(() => {
    if (flow !== 'authenticated') return;
    fetch('/api/admin/canary/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setCanaryNeedsAttention(!!(data?.status?.overdue || data?.status?.dueSoon)))
      .catch(() => {});
  }, [flow]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/reports?limit=${PAGE_SIZE}&offset=0`);
      if (res.status === 403 || res.status === 401) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error(messageForResponse(res, 'Failed to load reports'));
      const data = await res.json();
      setSummaries(data.summaries || []);
      setTotalCount(data.totalCount ?? (data.summaries || []).length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reports');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = async () => {
    if (!summaries) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/reports?limit=${PAGE_SIZE}&offset=${summaries.length}`);
      if (!res.ok) throw new Error(messageForResponse(res, 'Failed to load more reports'));
      const data = await res.json();
      setSummaries((prev) => [...(prev || []), ...(data.summaries || [])]);
      setTotalCount(data.totalCount ?? totalCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more reports');
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (flow === 'authenticated') load();
  }, [flow, load]);

  const toggleExpand = async (targetRelayId: string) => {
    if (expandedId === targetRelayId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(targetRelayId);
    if (detailCache[targetRelayId]) return;
    setDetailLoading(targetRelayId);
    try {
      const res = await fetch(`/api/admin/reports/detail?targetRelayId=${encodeURIComponent(targetRelayId)}`);
      if (!res.ok) throw new Error(messageForResponse(res, 'Failed to load detail'));
      const data = await res.json();
      setDetailCache((prev) => ({
        ...prev,
        [targetRelayId]: { reports: data.reports, totalCount: data.totalCount ?? data.reports.length, account: data.account },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load detail');
    } finally {
      setDetailLoading(null);
    }
  };

  const loadResolved = async () => {
    const next = !showResolved;
    setShowResolved(next);
    if (!next || resolved) return;
    setResolvedLoading(true);
    try {
      const res = await fetch('/api/admin/reports/resolved?limit=20');
      if (!res.ok) throw new Error(messageForResponse(res, 'Failed to load resolution history'));
      const data = await res.json();
      setResolved(data.reports || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load resolution history');
    } finally {
      setResolvedLoading(false);
    }
  };

  const act = async (targetRelayId: string, action: 'ban' | 'dismiss') => {
    setActingOn(targetRelayId);
    setError(null);
    try {
      const res = await fetch(action === 'ban' ? '/api/admin/ban' : '/api/admin/reports/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetRelayId }),
      });
      if (!res.ok) throw new Error(messageForResponse(res, `Failed to ${action}`));
      setSummaries((prev) => (prev ? prev.filter((s) => s.targetRelayId !== targetRelayId) : prev));
      setTotalCount((prev) => Math.max(0, prev - 1));
      if (expandedId === targetRelayId) setExpandedId(null);
      // Force a fresh fetch next time resolution history is opened, since
      // this action just added to it.
      setResolved(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setActingOn(null);
    }
  };

  if (flow !== 'authenticated') return null;

  const totalReports = summaries?.reduce((sum, s) => sum + s.count, 0) ?? 0;
  const clusteredCount = summaries?.filter((s) => s.clustered).length ?? 0;

  return (
    <div className="min-h-screen w-screen bg-relay-bg overflow-hidden flex flex-col">
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="border-b border-relay-border bg-relay-bg/80 backdrop-blur-sm px-6 py-4 flex items-center gap-4"
      >
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => router.back()}
          className="p-2 hover:bg-relay-surface-hover rounded-lg transition-colors"
          title="Back"
        >
          <ChevronLeft className="w-5 h-5 text-relay-text-secondary" />
        </motion.button>
        <h1 className="text-lg font-bold text-relay-text-primary flex-1">Abuse reports</h1>
        <Link href="/app/admin/canary" className="relay-btn-secondary text-xs px-3 py-1.5 inline-flex items-center gap-1.5">
          {canaryNeedsAttention && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />}
          Warrant canary
        </Link>
      </motion.div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 md:px-8 py-6 space-y-4">
          {forbidden && (
            <div className="p-4 bg-relay-surface-hover border border-relay-border rounded-lg text-sm text-relay-text-secondary">
              Not authorized. This page is restricted to the platform operator.
            </div>
          )}

          {!forbidden && error && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-600 dark:text-rose-400 text-xs">
              {error}
            </div>
          )}

          {!forbidden && !loading && summaries && (
            <div className="grid grid-cols-3 gap-3">
              <div className="relay-panel rounded-lg p-3 text-center">
                <p className="text-xl font-bold text-relay-text-primary">{totalCount}</p>
                <p className="text-[10px] text-relay-text-muted uppercase tracking-wider mt-0.5">Flagged Relay IDs</p>
              </div>
              <div className="relay-panel rounded-lg p-3 text-center">
                <p className="text-xl font-bold text-relay-text-primary">{totalReports}</p>
                <p className="text-[10px] text-relay-text-muted uppercase tracking-wider mt-0.5">Unresolved reports (loaded)</p>
              </div>
              <div className="relay-panel rounded-lg p-3 text-center">
                <p className={`text-xl font-bold ${clusteredCount > 0 ? 'text-amber-500' : 'text-relay-text-primary'}`}>
                  {clusteredCount}
                </p>
                <p className="text-[10px] text-relay-text-muted uppercase tracking-wider mt-0.5">Clustered (loaded)</p>
              </div>
            </div>
          )}

          {!forbidden && loading && (
            <div className="text-center py-10">
              <div className="inline-block w-7 h-7 border-2 border-relay-accent border-t-transparent rounded-full animate-spin" />
              <p className="text-relay-text-secondary text-sm mt-3">Loading reports…</p>
            </div>
          )}

          {!forbidden && !loading && summaries && summaries.length === 0 && (
            <p className="text-sm text-relay-text-secondary py-10 text-center">No unresolved reports.</p>
          )}

          {!forbidden && !loading && summaries?.map((s) => {
            const expanded = expandedId === s.targetRelayId;
            const detail = detailCache[s.targetRelayId];
            return (
              <div key={s.targetRelayId} className="relay-panel rounded-lg overflow-hidden">
                <div className="p-4 flex items-start justify-between gap-4">
                  <button
                    onClick={() => toggleExpand(s.targetRelayId)}
                    className="min-w-0 text-left flex-1 flex items-start gap-2"
                  >
                    <ChevronDown
                      className={`w-3.5 h-3.5 mt-0.5 shrink-0 text-relay-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <code className="text-xs font-mono text-relay-text-primary break-all">{s.targetRelayId}</code>
                        {s.clustered && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            title="Several reports arrived in a short window. Reporter identity is never recorded (by design), so this can't distinguish one account reporting repeatedly from several distinct people — treat it as a volume signal, not proof of a coordinated brigade."
                          >
                            <ShieldAlert className="w-3 h-3" /> Clustered
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-relay-text-secondary mt-1">
                        {s.count} report{s.count === 1 ? '' : 's'} ·{' '}
                        {Object.entries(s.categoryBreakdown).map(([cat, n]) => `${cat}: ${n}`).join(', ')}
                      </p>
                      <p className="text-[10px] text-relay-text-muted mt-0.5">
                        First {new Date(s.firstAt).toLocaleString()} · Last {new Date(s.lastAt).toLocaleString()}
                      </p>
                    </div>
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => act(s.targetRelayId, 'dismiss')}
                      disabled={actingOn === s.targetRelayId}
                      className="relay-btn-secondary text-xs px-3 py-1.5 inline-flex items-center gap-1.5"
                    >
                      <XCircle className="w-3 h-3" /> Dismiss
                    </button>
                    <button
                      onClick={() => act(s.targetRelayId, 'ban')}
                      disabled={actingOn === s.targetRelayId}
                      className="relay-btn-secondary text-xs px-3 py-1.5 inline-flex items-center gap-1.5 text-rose-500 dark:text-rose-400"
                    >
                      <Ban className="w-3 h-3" /> Ban
                    </button>
                  </div>
                </div>

                {expanded && (
                  <div className="border-t border-relay-border px-4 py-3 bg-relay-surface-hover/50 space-y-3">
                    {detailLoading === s.targetRelayId && (
                      <p className="text-xs text-relay-text-secondary">Loading detail…</p>
                    )}
                    {detail && (
                      <>
                        <div className="text-xs">
                          {detail.account ? (
                            <p className="text-relay-text-secondary">
                              Account exists · created {new Date(detail.account.createdAt).toLocaleDateString()}
                              {detail.account.lastLogin && ` · last login ${new Date(detail.account.lastLogin).toLocaleDateString()}`}
                              {detail.account.username && ` · @${detail.account.username}`}
                              {detail.account.displayName && ` · "${detail.account.displayName}"`}
                            </p>
                          ) : (
                            <p className="text-relay-text-muted">Account no longer exists (already deleted/banned).</p>
                          )}
                        </div>
                        {detail.totalCount > detail.reports.length && (
                          <p className="text-[10px] text-amber-600 dark:text-amber-400">
                            Showing the most recent {detail.reports.length} of {detail.totalCount} reports.
                          </p>
                        )}
                        <div className="space-y-1.5">
                          {detail.reports.map((r) => (
                            <div key={r.id} className="text-xs border-l-2 border-relay-border pl-2.5 py-0.5">
                              <span className="font-medium text-relay-text-primary">{r.category}</span>
                              <span className="text-relay-text-muted"> · {new Date(r.createdAt).toLocaleString()}</span>
                              {r.note && <p className="text-relay-text-secondary mt-0.5">&ldquo;{r.note}&rdquo;</p>}
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {!forbidden && summaries && summaries.length < totalCount && (
            <div className="text-center">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="relay-btn-secondary text-xs px-4 py-2"
              >
                {loadingMore ? 'Loading…' : `Load more (${summaries.length} of ${totalCount})`}
              </button>
            </div>
          )}

          {!forbidden && (
            <div className="pt-4 border-t border-relay-border">
              <button
                onClick={loadResolved}
                className="text-xs text-relay-text-secondary hover:text-relay-text-primary inline-flex items-center gap-1.5"
              >
                <History className="w-3.5 h-3.5" />
                {showResolved ? 'Hide' : 'Show'} resolution history
              </button>

              {showResolved && (
                <div className="mt-3 space-y-1.5">
                  {resolvedLoading && <p className="text-xs text-relay-text-secondary">Loading…</p>}
                  {!resolvedLoading && resolved?.length === 0 && (
                    <p className="text-xs text-relay-text-muted">No resolved reports yet.</p>
                  )}
                  {!resolvedLoading && resolved?.map((r) => (
                    <div key={r.id} className="text-xs flex items-center gap-2 flex-wrap">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          r.resolution === 'banned'
                            ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                            : 'bg-relay-surface-hover text-relay-text-secondary'
                        }`}
                      >
                        {r.resolution}
                      </span>
                      <code className="font-mono text-relay-text-secondary break-all">{r.targetRelayId}</code>
                      <span className="text-relay-text-muted">
                        {r.category} · {r.resolvedAt && new Date(r.resolvedAt).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
