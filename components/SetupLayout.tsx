'use client';

import { motion } from 'framer-motion';
import { RelayLogo } from '@/components/RelayLogo';

interface SetupLayoutProps {
  step: number;
  totalSteps: number;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

export const SetupLayout = ({
  step,
  totalSteps,
  title,
  subtitle,
  children,
}: SetupLayoutProps) => {
  return (
    <div className="mk-marketing min-h-screen bg-relay-bg flex flex-col">
      {/* Header with progress */}
      <div className="px-6 py-8">
        <div className="max-w-sm mx-auto">
          {/* Progress indicator */}
          <div className="flex gap-2 mb-8">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <motion.div
                key={i}
                className="h-1 flex-1 rounded-full bg-relay-surface-hover"
                animate={{
                  backgroundColor: i < step ? '#7F77DD' : 'rgb(39, 39, 42)',
                }}
                transition={{ duration: 0.3 }}
              />
            ))}
          </div>

          {/* Step indicator */}
          <div className="text-sm text-relay-text-secondary mb-6">
            Step {step} of {totalSteps}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 px-6 pb-12 overflow-auto">
        <div className="max-w-sm mx-auto">
          {/* Logo */}
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.4 }}
            className="flex justify-center mb-8"
          >
            <RelayLogo size="lg" className="text-relay-accent" />
          </motion.div>

          {/* Title */}
          <motion.div
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="mb-8 text-center"
          >
            <h1 className="text-3xl font-bold text-white mb-2">{title}</h1>
            {subtitle && <p className="text-relay-text-secondary">{subtitle}</p>}
          </motion.div>

          {/* Main content */}
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.2 }}
          >
            {children}
          </motion.div>
        </div>
      </div>
    </div>
  );
};
