'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Lock, CheckCircle } from 'lucide-react';

const ENCRYPTION_STATES = [
  'Negotiating keys...',
  'ECDH handshake ✓',
  'Dictionary synced ✓',
  'Neural model active ✓',
];

export const EncryptionBadge = () => {
  const [stateIndex, setStateIndex] = useState(0);
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    if (stateIndex < ENCRYPTION_STATES.length - 1) {
      const timer = setTimeout(() => {
        setStateIndex(stateIndex + 1);
      }, 800);
      return () => clearTimeout(timer);
    } else {
      setIsComplete(true);
    }
  }, [stateIndex]);

  const currentState = ENCRYPTION_STATES[stateIndex];

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
        isComplete
          ? 'bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/30'
          : 'bg-relay-accent/10 text-relay-accent border border-relay-accent/30'
      }`}
    >
      <motion.div
        animate={isComplete ? { rotate: 360 } : { scale: [1, 1.1, 1] }}
        transition={
          isComplete
            ? { duration: 0.5 }
            : { duration: 1.5, repeat: Infinity }
        }
      >
        {isComplete ? (
          <CheckCircle className="w-3.5 h-3.5" />
        ) : (
          <Lock className="w-3.5 h-3.5" />
        )}
      </motion.div>

      <motion.span
        key={currentState}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.3 }}
      >
        {currentState}
      </motion.span>

      {/* CryptoPress E2E Badge Pulse */}
      {isComplete && (
        <motion.span
          className="ml-1 px-2 py-0.5 bg-relay-accent/15 text-relay-accent rounded text-xs font-medium"
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          E2E
        </motion.span>
      )}
    </motion.div>
  );
};
