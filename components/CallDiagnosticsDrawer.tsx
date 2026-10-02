'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Copy, Check, ChevronDown } from 'lucide-react';
import type { CallQualityMetrics, CallDiagnosticEvent } from '@/lib/calls/use-webrtc-call';

interface CallDiagnosticsDrawerProps {
  quality: CallQualityMetrics | null;
  diagnostics: CallDiagnosticEvent[];
  onClose: () => void;
}

function MetricRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-relay-border/60 last:border-0">
      <span className="text-xs text-relay-text-secondary">{label}</span>
      <span className={`text-xs font-mono font-medium ${warn ? 'text-amber-500' : 'text-relay-text-primary'}`}>
        {value}
      </span>
    </div>
  );
}

const LEVEL_COLORS: Record<CallDiagnosticEvent['level'], string> = {
  info: 'text-relay-text-muted',
  warn: 'text-amber-500',
  error: 'text-relay-danger',
};

export function CallDiagnosticsDrawer({ quality, diagnostics, onClose }: CallDiagnosticsDrawerProps) {
  const [copied, setCopied] = useState(false);

  const copyDiagnostics = async () => {
    const payload = JSON.stringify({ quality, diagnostics }, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  return (
    <motion.div
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      className="absolute inset-x-0 bottom-0 z-20 bg-relay-bg border-t border-relay-border rounded-t-2xl max-h-[70%] flex flex-col"
    >
      {/* Handle */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 pt-3 pb-2 border-b border-relay-border">
        <div className="flex items-center gap-2">
          <ChevronDown className="w-4 h-4 text-relay-text-muted" />
          <span className="text-sm font-medium text-relay-text-primary">Call Diagnostics</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={copyDiagnostics}
            className="flex items-center gap-1.5 text-xs text-relay-text-secondary hover:text-relay-text-primary transition-colors px-2 py-1 rounded-md hover:bg-relay-surface-hover"
          >
            {copied ? <Check className="w-3 h-3 text-relay-success" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md text-relay-text-muted hover:text-relay-text-primary hover:bg-relay-surface-hover transition-colors"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Live metrics */}
        {quality && (
          <div className="px-4 py-3 border-b border-relay-border/60">
            <p className="text-xs font-semibold text-relay-text-secondary uppercase tracking-wider mb-2">Live Metrics</p>
            <MetricRow label="Round-trip time" value={`${quality.roundTripTimeMs.toFixed(0)} ms`} warn={quality.roundTripTimeMs > 200} />
            <MetricRow label="Jitter" value={`${quality.jitterMs.toFixed(0)} ms`} warn={quality.jitterMs > 30} />
            <MetricRow label="Packet loss" value={`${quality.packetLossPct.toFixed(2)}%`} warn={quality.packetLossPct > 2} />
            <MetricRow label="Bitrate" value={`${quality.bitrateKbps.toFixed(1)} kbps`} />
            <MetricRow label="Audio level" value={quality.audioLevel.toFixed(3)} />
            <MetricRow label="ICE state" value={quality.iceConnectionState} />
            <MetricRow label="Connection" value={quality.connectionState} />
            <MetricRow label="Reconnects" value={String(quality.reconnectAttempts)} warn={quality.reconnectAttempts > 0} />
          </div>
        )}

        {/* Event log */}
        <div className="px-4 py-3">
          <p className="text-xs font-semibold text-relay-text-secondary uppercase tracking-wider mb-2">
            Event Log ({diagnostics.length})
          </p>
          {diagnostics.length === 0 && (
            <p className="text-xs text-relay-text-muted italic">No events yet.</p>
          )}
          <div className="space-y-1">
            {[...diagnostics].reverse().map((event) => (
              <div key={event.id} className="flex items-start gap-2">
                <span className="text-[10px] font-mono text-relay-text-muted flex-shrink-0 mt-0.5 w-14">
                  {new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className={`text-xs flex-1 font-mono ${LEVEL_COLORS[event.level]}`}>
                  [{event.code}] {event.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
