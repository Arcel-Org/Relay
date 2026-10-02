'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  ChevronLeft,
  ShieldCheck,
  AlertTriangle,
  Clock,
  Trash2,
  FileText,
  ShieldAlert,
} from 'lucide-react';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import type { CanaryStatus, LegalRequestRecord } from '@/lib/db/canary-db';
import {
  LEGAL_REQUEST_CATEGORIES,
  LEGAL_REQUEST_CATEGORY_LABELS,
  type LegalRequestCategory,
} from '@/lib/legal/legal-request-categories';

/** 429s share one message everywhere on this page rather than falling through to a generic "failed" string. */
function messageForResponse(res: Response, fallback: string): string {
  return res.status === 429 ? 'Rate limited — wait a moment and try again.' : fallback;
}

function formatDateTime(ms: number): string {
  return `${new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })} at ${new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })}`;
}

/**
 * Warrant-canary admin panel — operator-only (server enforces this via
 * requireAdmin regardless of what this page renders). Two independent
 * actions live here: confirming the public canary's six statements are
 * still true (stamps a timestamp only — never edits the statement text
 * itself, since that's a legal judgment call for a human to make by hand in
 * app/legal/canary/page.tsx), and recording a real legal request received,
 * with a redacted PDF published to /legal/transparency.
 */
export default function AdminCanaryPage() {
  const router = useRouter();
  const { flow } = useRelayAuthStoreV2();
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<CanaryStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);

  const [requests, setRequests] = useState<LegalRequestRecord[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<LegalRequestCategory>('other');
  const [receivedAt, setReceivedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (flow !== 'authenticated') {
      router.push('/auth/login');
    }
  }, [flow, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, requestsRes] = await Promise.all([
        fetch('/api/admin/canary/status'),
        fetch('/api/admin/canary/legal-requests'),
      ]);
      if (statusRes.status === 403 || statusRes.status === 401) {
        setForbidden(true);
        return;
      }
      if (!statusRes.ok) throw new Error(messageForResponse(statusRes, 'Failed to load canary status'));
      if (!requestsRes.ok) throw new Error(messageForResponse(requestsRes, 'Failed to load legal requests'));
      const statusData = await statusRes.json();
      const requestsData = await requestsRes.json();
      setStatus(statusData.status);
      setRequests(requestsData.requests || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (flow === 'authenticated') load();
  }, [flow, load]);

  const confirmCanary = async () => {
    setConfirming(true);
    setError(null);
    setConfirmMessage(null);
    try {
      const res = await fetch('/api/admin/canary/confirm', { method: 'POST' });
      if (!res.ok) throw new Error(messageForResponse(res, 'Failed to confirm'));
      const data = await res.json();
      setStatus(data.status);
      setConfirmMessage(`Confirmed at ${formatDateTime(data.status.confirmedAt)}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm');
    } finally {
      setConfirming(false);
    }
  };

  const submitLegalRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!title.trim()) return setFormError('Title is required.');
    if (!receivedAt) return setFormError('Date received is required.');
    if (!file) return setFormError('A redacted PDF is required.');
    if (file.type && file.type !== 'application/pdf') return setFormError('File must be a PDF.');

    setSubmitting(true);
    try {
      const form = new FormData();
      form.set('title', title.trim());
      form.set('category', category);
      form.set('receivedAt', receivedAt);
      if (notes.trim()) form.set('notes', notes.trim());
      form.set('pdf', file);

      const res = await fetch('/api/admin/canary/legal-requests', { method: 'POST', body: form });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || messageForResponse(res, 'Failed to record legal request'));
      }
      setTitle('');
      setCategory('other');
      setReceivedAt('');
      setNotes('');
      setFile(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to record legal request');
    } finally {
      setSubmitting(false);
    }
  };

  const deleteRequest = async (id: string) => {
    setDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/canary/legal-requests?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(messageForResponse(res, 'Failed to delete'));
      setRequests((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeletingId(null);
    }
  };

  if (flow !== 'authenticated') return null;

  const statusIcon = !status ? null : status.overdue ? (
    <span className="inline-flex items-center gap-1.5 text-rose-500 dark:text-rose-400">
      <AlertTriangle className="w-4 h-4" /> Overdue — confirm now
    </span>
  ) : status.dueSoon ? (
    <span className="inline-flex items-center gap-1.5 text-amber-500 dark:text-amber-400">
      <Clock className="w-4 h-4" /> Due soon
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-emerald-500 dark:text-emerald-400">
      <ShieldCheck className="w-4 h-4" /> Up to date
    </span>
  );

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
        <h1 className="text-lg font-bold text-relay-text-primary flex-1">Warrant canary</h1>
        <Link href="/app/admin" className="relay-btn-secondary text-xs px-3 py-1.5">
          Abuse reports
        </Link>
      </motion.div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 md:px-8 py-6 space-y-6">
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

          {!forbidden && loading && (
            <div className="text-center py-10">
              <div className="inline-block w-7 h-7 border-2 border-relay-accent border-t-transparent rounded-full animate-spin" />
              <p className="text-relay-text-secondary text-sm mt-3">Loading…</p>
            </div>
          )}

          {!forbidden && !loading && (
            <div className="relay-panel rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h2 className="text-sm font-semibold text-relay-text-primary">Confirmation status</h2>
                {statusIcon}
              </div>
              <div className="text-xs text-relay-text-secondary space-y-1">
                <p>Last confirmed: {status ? formatDateTime(status.confirmedAt) : 'never'}</p>
                <p>Next check-in due: {status ? new Date(status.nextDueAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '—'}</p>
              </div>

              {status && status.legalRequestsSinceConfirmation > 0 && (
                <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-700 dark:text-amber-400 text-xs flex items-start gap-2">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    {status.legalRequestsSinceConfirmation} legal request{status.legalRequestsSinceConfirmation === 1 ? '' : 's'} recorded since your last confirmation. Make sure the six statements on the public canary page still accurately reflect this before confirming again.
                  </span>
                </div>
              )}

              <button
                onClick={confirmCanary}
                disabled={confirming}
                className="relay-btn-primary text-xs px-4 py-2"
              >
                {confirming ? 'Confirming…' : 'Confirm — no legal process received'}
              </button>
              {confirmMessage && <p className="text-xs text-emerald-600 dark:text-emerald-400">{confirmMessage}</p>}
            </div>
          )}

          {!forbidden && !loading && (
            <div className="relay-panel rounded-lg p-4 space-y-4">
              <h2 className="text-sm font-semibold text-relay-text-primary">Record a legal request received</h2>
              <p className="text-xs text-relay-text-secondary">
                Upload a redacted copy of the document. This is published publicly on the <Link href="/legal/transparency" className="underline">transparency report</Link> — redact before uploading.
              </p>
              <form onSubmit={submitLegalRequest} className="space-y-3">
                <div>
                  <label className="block text-xs text-relay-text-secondary mb-1" htmlFor="lr-title">Title</label>
                  <input
                    id="lr-title"
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="relay-input w-full text-sm"
                    placeholder="e.g. Grand jury subpoena — E.D. Va."
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-relay-text-secondary mb-1" htmlFor="lr-category">Category</label>
                    <select
                      id="lr-category"
                      value={category}
                      onChange={(e) => setCategory(e.target.value as LegalRequestCategory)}
                      className="relay-input w-full text-sm"
                    >
                      {LEGAL_REQUEST_CATEGORIES.map((c) => (
                        <option key={c} value={c}>{LEGAL_REQUEST_CATEGORY_LABELS[c]}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-relay-text-secondary mb-1" htmlFor="lr-received">Date received</label>
                    <input
                      id="lr-received"
                      type="date"
                      value={receivedAt}
                      onChange={(e) => setReceivedAt(e.target.value)}
                      className="relay-input w-full text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-relay-text-secondary mb-1" htmlFor="lr-notes">Internal notes (not published)</label>
                  <textarea
                    id="lr-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="relay-input w-full text-sm"
                    rows={2}
                  />
                </div>
                <div>
                  <label className="block text-xs text-relay-text-secondary mb-1" htmlFor="lr-pdf">Redacted PDF</label>
                  <input
                    id="lr-pdf"
                    type="file"
                    accept="application/pdf"
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                    className="text-xs text-relay-text-secondary"
                  />
                </div>
                {formError && <p className="text-xs text-rose-500 dark:text-rose-400">{formError}</p>}
                <button type="submit" disabled={submitting} className="relay-btn-primary text-xs px-4 py-2">
                  {submitting ? 'Uploading…' : 'Publish legal request'}
                </button>
              </form>
            </div>
          )}

          {!forbidden && !loading && requests && (
            <div className="relay-panel rounded-lg p-4 space-y-3">
              <h2 className="text-sm font-semibold text-relay-text-primary">Published legal requests</h2>
              {requests.length === 0 && (
                <p className="text-xs text-relay-text-muted">None on file.</p>
              )}
              {requests.map((r) => (
                <div key={r.id} className="flex items-start justify-between gap-3 border-t border-relay-border pt-3 first:border-t-0 first:pt-0">
                  <div className="min-w-0">
                    <p className="text-sm text-relay-text-primary">{r.title}</p>
                    <p className="text-xs text-relay-text-secondary">
                      {LEGAL_REQUEST_CATEGORY_LABELS[r.category]} · received {new Date(r.receivedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}
                    </p>
                    {r.notes && <p className="text-xs text-relay-text-muted mt-0.5">{r.notes}</p>}
                    <a
                      href={`/api/legal/canary-requests/pdf?id=${r.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-relay-accent inline-flex items-center gap-1 mt-1"
                    >
                      <FileText className="w-3 h-3" /> View PDF
                    </a>
                  </div>
                  <button
                    onClick={() => deleteRequest(r.id)}
                    disabled={deletingId === r.id}
                    className="relay-btn-secondary text-xs px-2.5 py-1.5 inline-flex items-center gap-1.5 text-rose-500 dark:text-rose-400 shrink-0"
                  >
                    <Trash2 className="w-3 h-3" /> Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
