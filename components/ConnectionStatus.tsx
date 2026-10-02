'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, Wifi, WifiOff } from 'lucide-react';

export interface ConnectionStatusProps {
  status: 'connected' | 'connecting' | 'disconnected' | 'reconnecting' | 'error';
  attemptCount?: number;
  onRetry?: () => void;
}

export function ConnectionStatus({ status, attemptCount, onRetry }: ConnectionStatusProps) {
  const statusConfig = {
    connected: {
      show: false,
      icon: Wifi,
      text: 'Connected',
      bg: 'bg-emerald-500/15',
      border: 'border-emerald-500/50',
      textColor: 'text-emerald-600 dark:text-emerald-400',
      dotColor: 'bg-emerald-500',
    },
    connecting: {
      show: true,
      icon: Wifi,
      text: 'Connecting...',
      bg: 'bg-amber-500/15',
      border: 'border-amber-500/50',
      textColor: 'text-amber-600 dark:text-amber-400',
      dotColor: 'bg-amber-500 animate-pulse',
    },
    reconnecting: {
      show: true,
      icon: Wifi,
      text: 'Reconnecting — your messages are safe',
      bg: 'bg-amber-500/15',
      border: 'border-amber-500/50',
      textColor: 'text-amber-600 dark:text-amber-400',
      dotColor: 'bg-amber-500 animate-pulse',
    },
    disconnected: {
      show: true,
      icon: WifiOff,
      text: "You're offline — messages will send when you reconnect",
      bg: 'bg-rose-500/15',
      border: 'border-rose-500/50',
      textColor: 'text-rose-600 dark:text-rose-400',
      dotColor: 'bg-rose-500',
    },
    error: {
      show: true,
      icon: AlertCircle,
      text: "Can't reach server — tap Retry to reconnect",
      bg: 'bg-rose-500/15',
      border: 'border-rose-500/50',
      textColor: 'text-rose-600 dark:text-rose-400',
      dotColor: 'bg-rose-500',
    },
  };

  const config = statusConfig[status];
  const IconComponent = config.icon;

  return (
    <AnimatePresence>
      {config.show && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          role="status"
          aria-live="polite"
          className={`${config.bg} ${config.border} border px-4 py-3 flex items-center justify-between gap-3 rounded-lg`}
        >
          <div className="flex items-center gap-2 flex-1">
            <div className={`w-2 h-2 rounded-full ${config.dotColor}`} />
            <div className="flex items-center gap-2 flex-1">
              <IconComponent size={16} className={config.textColor} />
              <span className={`text-sm font-medium ${config.textColor}`}>
                {config.text}
              </span>
            </div>
          </div>

          {(status === 'error' || status === 'disconnected') && onRetry && (
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={onRetry}
              className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 rounded text-xs font-semibold text-white shadow-sm transition-colors"
            >
              Retry
            </motion.button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
