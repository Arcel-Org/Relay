'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Wordmark } from '@/components/marketing/Wordmark';
import { ThemeToggle } from '@/components/marketing/ThemeToggle';

const POLL_INTERVAL_MS = 15_000;

interface StatusResponse {
  ok: boolean;
  relayReachable: boolean;
  uptimeSeconds: number;
  wsConnections?: number;
  version: string;
  timestamp: number;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

export default function StatusPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const poll = async () => {
      try {
        const res = await fetch('/api/status', { cache: 'no-store' });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: StatusResponse = await res.json();
        if (!mountedRef.current) return;
        setStatus(data);
        setError(false);
        setLastChecked(new Date());
      } catch {
        if (!mountedRef.current) return;
        setError(true);
        setLastChecked(new Date());
      }
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, []);

  const healthy = !error && status?.ok === true;
  const indicatorColor = healthy ? 'var(--mk-success)' : 'var(--mk-accent)';
  const statusLabel = !status && !error ? 'Checking…' : healthy ? 'Operational' : 'Disruption';

  return (
    <div className="mk-marketing">
      <header
        className="sticky top-0 z-40 backdrop-blur-md"
        style={{ background: 'color-mix(in srgb, var(--mk-bg) 80%, transparent)', borderBottom: '1px solid var(--mk-border)' }}
      >
        <div className="max-w-3xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <Wordmark />
            <span className="text-[10px] uppercase tracking-[0.25em]" style={{ color: 'var(--mk-text-3)' }}>Relay</span>
          </Link>
          <nav className="flex items-center gap-1">
            <ThemeToggle />
            <Link href="/" className="mk-btn-ghost">← Home</Link>
          </nav>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-20">
        <div className="mk-eyebrow mb-3">System status</div>
        <h1 className="text-3xl font-bold mb-2" style={{ color: 'var(--mk-text)' }}>Relay status</h1>
        <p className="mb-10" style={{ color: 'var(--mk-text-2)' }}>
          Live health of the relay server. This page refreshes automatically every 15 seconds and requires no sign-in.
        </p>

        <div className="mk-card p-6 mb-6 flex items-center gap-4">
          <span
            aria-hidden
            className="w-3 h-3 rounded-full flex-shrink-0"
            style={{ background: indicatorColor, boxShadow: `0 0 12px ${indicatorColor}` }}
          />
          <div>
            <div className="text-lg font-semibold" style={{ color: 'var(--mk-text)' }}>{statusLabel}</div>
            <div className="text-xs" style={{ color: 'var(--mk-text-3)' }}>
              {lastChecked ? `Last checked ${lastChecked.toLocaleTimeString()}` : 'Awaiting first check…'}
            </div>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="mk-card p-6">
            <div className="text-[10px] uppercase tracking-[0.2em] mb-2" style={{ color: 'var(--mk-text-3)' }}>
              Relay reachability
            </div>
            <div className="text-xl font-semibold" style={{ color: status?.relayReachable ? 'var(--mk-success)' : 'var(--mk-accent)' }}>
              {!status && !error ? '—' : status?.relayReachable ? 'Reachable' : 'Unreachable'}
            </div>
          </div>

          <div className="mk-card p-6">
            <div className="text-[10px] uppercase tracking-[0.2em] mb-2" style={{ color: 'var(--mk-text-3)' }}>
              Uptime
            </div>
            <div className="text-xl font-semibold" style={{ color: 'var(--mk-text)' }}>
              {status ? formatUptime(status.uptimeSeconds) : '—'}
            </div>
          </div>

          <div className="mk-card p-6">
            <div className="text-[10px] uppercase tracking-[0.2em] mb-2" style={{ color: 'var(--mk-text-3)' }}>
              Version
            </div>
            <div className="text-xl font-semibold" style={{ color: 'var(--mk-text)' }}>
              {status?.version ?? '—'}
            </div>
          </div>

          <div className="mk-card p-6">
            <div className="text-[10px] uppercase tracking-[0.2em] mb-2" style={{ color: 'var(--mk-text-3)' }}>
              Last update
            </div>
            <div className="text-xl font-semibold" style={{ color: 'var(--mk-text)' }}>
              {status ? new Date(status.timestamp).toLocaleTimeString() : '—'}
            </div>
          </div>
        </div>

        {error && (
          <p className="mt-6 text-sm" style={{ color: 'var(--mk-accent)' }}>
            Could not reach the status endpoint. Retrying automatically…
          </p>
        )}
      </main>

      <footer style={{ borderTop: '1px solid var(--mk-border)' }}>
        <div className="max-w-3xl mx-auto px-6 py-8 flex justify-between text-xs" style={{ color: 'var(--mk-text-4)' }}>
          <div>© {new Date().getFullYear()} Arcel</div>
          <Link href="/" className="uppercase tracking-[0.2em]" style={{ color: 'var(--mk-text-2)' }}>← home</Link>
        </div>
      </footer>
    </div>
  );
}
