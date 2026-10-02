'use client';

import { create } from 'zustand';
import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, AlertCircle, Info, X, AlertTriangle } from 'lucide-react';

// ─── Store ───

export type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  durationMs: number;
  createdAt: number;
}

interface ToastState {
  toasts: Toast[];
  addToast: (type: ToastType, title: string, message?: string, durationMs?: number) => string;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  addToast: (type, title, message, durationMs = 4000) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const toast: Toast = { id, type, title, message, durationMs, createdAt: Date.now() };
    set((state) => ({ toasts: [...state.toasts.slice(-4), toast] })); // Keep max 5
    return id;
  },

  removeToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));

// ─── Convenience helpers ───

export const toast = {
  success: (title: string, message?: string) => useToastStore.getState().addToast('success', title, message),
  error: (title: string, message?: string) => useToastStore.getState().addToast('error', title, message, 0),
  info: (title: string, message?: string) => useToastStore.getState().addToast('info', title, message),
  warning: (title: string, message?: string) => useToastStore.getState().addToast('warning', title, message, 5000),
};

// ─── UI Component ───

const ICONS: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />,
  error: <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400" />,
  info: <Info className="w-5 h-5 text-blue-600 dark:text-blue-400" />,
  warning: <AlertTriangle className="w-5 h-5 text-yellow-600 dark:text-yellow-400" />,
};

const BG: Record<ToastType, string> = {
  success: 'border-green-500/30 bg-green-950/60',
  error: 'border-red-500/30 bg-red-950/60',
  info: 'border-relay-accent-muted/30 bg-blue-950/60',
  warning: 'border-yellow-500/30 bg-yellow-950/60',
};

function ToastItem({ toast: t, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  useEffect(() => {
    if (t.durationMs <= 0) return; // No auto-dismiss (e.g. error toasts)
    // onDismiss (removeToast) is a stable store action and t.id/t.durationMs
    // are constant for a given toast, so this timer isn't reset when
    // unrelated toasts are added or removed and ToastContainer re-renders.
    const timer = setTimeout(() => onDismiss(t.id), t.durationMs);
    return () => clearTimeout(timer);
  }, [t.id, t.durationMs, onDismiss]);

  const role = t.type === 'error' || t.type === 'warning' ? 'alert' : 'status';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 80, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 80, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
      className={`flex items-start gap-3 px-4 py-3 rounded-lg border backdrop-blur-sm shadow-lg max-w-sm ${BG[t.type]}`}
    >
      <div className="mt-0.5 shrink-0">{ICONS[t.type]}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white">{t.title}</p>
        {t.message && <p className="text-xs text-relay-text-secondary mt-0.5">{t.message}</p>}
      </div>
      <button
        onClick={() => onDismiss(t.id)}
        aria-label="Dismiss notification"
        className="shrink-0 text-relay-text-muted hover:text-relay-text-secondary transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </motion.div>
  );
}

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  return (
    <div className="fixed top-4 right-4 z-[200] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence mode="popLayout">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto">
            <ToastItem toast={t} onDismiss={removeToast} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}
