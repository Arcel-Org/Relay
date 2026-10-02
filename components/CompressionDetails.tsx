'use client';

import { motion } from 'framer-motion';
import { useState, useEffect, useRef } from 'react';
import type { Message } from '@/lib/mock-data';
import { X } from 'lucide-react';

interface CompressionDetailsProps {
  message: Message;
  onClose: () => void;
}

export const CompressionDetails = ({ message, onClose }: CompressionDetailsProps) => {
  const [backdropClickEnabled, setBackdropClickEnabled] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Add delay before backdrop can close modal to prevent flickering
  useEffect(() => {
    const timer = setTimeout(() => setBackdropClickEnabled(true), 150);
    return () => clearTimeout(timer);
  }, []);

  // Focus management: move focus into the dialog on mount, restore it on unmount
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const id = requestAnimationFrame(() => containerRef.current?.focus());
    return () => {
      cancelAnimationFrame(id);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, []);

  // Escape to close, Tab to stay trapped inside the dialog
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const container = containerRef.current;
        if (!container) return;
        const focusable = Array.from(
          container.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const meta = message.metadata;

  const chartData = [
    {
      name: 'Original',
      size: meta.original_size,
      color: '#7F77DD',
    },
    {
      name: 'Compressed',
      size: meta.compressed_size,
      color: '#22c55e',
    },
    {
      name: 'Encrypted',
      size: meta.encrypted_size,
      color: '#f59e0b',
    },
  ];

  const maxChartSize = Math.max(...chartData.map((d) => d.size));
  const savings = meta.original_size - meta.compressed_size;
  const savingsPercent = meta.original_size > 0 ? ((savings / meta.original_size) * 100).toFixed(1) : '0.0';

  return (
    <motion.div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Encryption Details"
      tabIndex={-1}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-end z-50 outline-none"
      onClick={() => backdropClickEnabled && onClose()}
    >
      <motion.div
        className="w-full bg-relay-surface rounded-t-3xl border-t border-relay-border p-6 space-y-6"
        onClick={(e) => e.stopPropagation()}
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-relay-text-primary">Encryption Details</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 hover:bg-relay-surface-hover rounded-lg transition-colors"
          >
            <X className="w-4 h-4 text-relay-text-secondary" aria-hidden="true" />
          </button>
        </div>

        {/* Chart */}
        <div className="bg-relay-surface-hover/50 rounded-lg p-4 border border-relay-border-light space-y-3">
          {chartData.map((item) => {
            const widthPercent = maxChartSize > 0 ? (item.size / maxChartSize) * 100 : 0;
            return (
              <div key={item.name} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-relay-text-secondary">{item.name}</span>
                  <span className="text-relay-text-secondary">{(item.size / 1024).toFixed(1)} KB</span>
                </div>
                <div className="w-full h-6 bg-relay-surface-hover/50 rounded-lg overflow-hidden">
                  <motion.div
                    className="h-full rounded-lg"
                    style={{ backgroundColor: item.color }}
                    initial={{ width: 0 }}
                    animate={{ width: `${widthPercent}%` }}
                    transition={{ duration: 0.5, ease: 'easeOut' }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-relay-surface-hover/50 rounded-lg p-4 border border-relay-border-light">
            <p className="text-xs text-relay-text-secondary mb-2">Original Size</p>
            <p className="text-lg font-semibold text-relay-text-primary">
              {(meta.original_size / 1024).toFixed(1)} KB
            </p>
          </div>
          <div className="bg-relay-surface-hover/50 rounded-lg p-4 border border-relay-border-light">
            <p className="text-xs text-relay-text-secondary mb-2">Compressed</p>
            <p className="text-lg font-semibold text-green-600 dark:text-green-400">
              {(meta.compressed_size / 1024).toFixed(1)} KB
            </p>
          </div>
          <div className="bg-relay-surface-hover/50 rounded-lg p-4 border border-relay-border-light">
            <p className="text-xs text-relay-text-secondary mb-2">Compression Ratio</p>
            <p className="text-lg font-semibold text-relay-accent">
              {(meta.compression_ratio * 100).toFixed(1)}%
            </p>
          </div>
          <div className="bg-relay-surface-hover/50 rounded-lg p-4 border border-relay-border-light">
            <p className="text-xs text-relay-text-secondary mb-2">Saved</p>
            <p className="text-lg font-semibold text-relay-text-primary">
              {savingsPercent}%
            </p>
          </div>
        </div>

        {/* Advanced Metrics */}
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-relay-text-secondary">Advanced Metrics</h4>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between items-center p-2 bg-relay-surface-hover/50 rounded-lg border border-relay-border-light">
              <span className="text-relay-text-secondary">Latency</span>
              <span className="text-relay-text-primary font-medium">{meta.latency_ms}ms</span>
            </div>
            <div className="flex justify-between items-center p-2 bg-relay-surface-hover/50 rounded-lg border border-relay-border-light">
              <span className="text-relay-text-secondary">Neural Model Score</span>
              <motion.span
                className="text-relay-text-primary font-medium"
                animate={{ color: meta.neural_model_score > 0.6 ? '#22c55e' : '#f59e0b' }}
              >
                {(meta.neural_model_score * 100).toFixed(1)}%
              </motion.span>
            </div>
            <div className="flex justify-between items-center p-2 bg-relay-surface-hover/50 rounded-lg border border-relay-border-light">
              <span className="text-relay-text-secondary">Encrypted Size</span>
              <span className="text-relay-text-primary font-medium">
                {(meta.encrypted_size / 1024).toFixed(1)} KB
              </span>
            </div>
          </div>
        </div>

        {/* Close Button */}
        <button
          onClick={onClose}
          className="w-full py-3 bg-relay-accent hover:bg-relay-accent/90 rounded-xl font-medium text-relay-text-primary transition-colors"
        >
          Close
        </button>
      </motion.div>
    </motion.div>
  );
};
