'use client';

import { motion, AnimatePresence } from 'framer-motion';

interface TypingIndicatorProps {
  senderName: string;
  isVisible?: boolean;
}

export const TypingIndicator = ({ senderName, isVisible = true }: TypingIndicatorProps) => {
  const dotVariants = {
    animate: {
      y: [0, -8, 0],
      transition: {
        duration: 0.6,
        repeat: Infinity,
      },
    },
  };

  const containerVariants = {
    animate: {
      transition: {
        staggerChildren: 0.1,
      },
    },
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.3 } }}
          className="flex items-end gap-2 mb-2"
          role="status"
          aria-live="polite"
        >
          <motion.div
            className="w-8 h-8 rounded-full bg-relay-surface border border-relay-accent/40 flex items-center justify-center text-xs font-bold text-relay-accent"
          >
            {senderName.split(' ').map(n => n[0]).join('').toUpperCase()}
          </motion.div>

          <motion.div
            className="flex items-center gap-1.5 px-4 py-3 bg-relay-surface-hover/80 rounded-xl rounded-bl-none"
            variants={containerVariants}
            animate="animate"
          >
            <motion.span
              className="w-2 h-2 bg-relay-text-muted rounded-full"
              variants={dotVariants}
            />
            <motion.span
              className="w-2 h-2 bg-relay-text-muted rounded-full"
              variants={dotVariants}
            />
            <motion.span
              className="w-2 h-2 bg-relay-text-muted rounded-full"
              variants={dotVariants}
            />
          </motion.div>

          <div className="text-xs text-relay-text-muted">{senderName} is typing...</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
