'use client';

import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { RelayLogo } from '@/components/RelayLogo';

export default function NotFound() {
  const router = useRouter();

  return (
    <div className="relative min-h-screen bg-relay-bg flex flex-col items-center justify-center p-4">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-20 left-10 w-72 h-72 bg-relay-accent/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-20 right-10 w-72 h-72 bg-relay-accent-muted/10 rounded-full blur-3xl animate-pulse delay-1000" />
      </div>

      {/* Content */}
      <motion.div
        className="relative z-10 text-center space-y-8 max-w-md"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        {/* Logo */}
        <motion.div
          initial={{ scale: 0.8 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.1, duration: 0.4 }}
          className="flex justify-center"
        >
          <RelayLogo size="xl" className="text-relay-accent" />
        </motion.div>

        {/* 404 Text */}
        <div className="space-y-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-7xl font-black text-relay-text-primary bg-relay-surface"
          >
            404
          </motion.div>

          <motion.h1
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="text-3xl font-bold text-relay-text-primary"
          >
            Page Not Found
          </motion.h1>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="text-relay-text-secondary text-lg leading-relaxed"
          >
            The page you're looking for doesn't exist or has been encrypted into oblivion. Let's get you back on track.
          </motion.p>
        </div>

        {/* Info Box */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="p-4 bg-relay-surface/50 border border-relay-border rounded-lg space-y-3"
        >
          <p className="text-sm text-relay-text-secondary">
            <span className="font-semibold">Quick links:</span>
          </p>
          <div className="flex gap-2 justify-center flex-wrap">
            <button
              onClick={() => router.push('/')}
              className="px-3 py-2 bg-relay-surface hover:bg-relay-surface-hover rounded text-sm text-relay-text-primary transition-colors"
            >
              Home
            </button>
            <button
              onClick={() => router.push('/app')}
              className="px-3 py-2 bg-relay-surface hover:bg-relay-surface-hover rounded text-sm text-relay-text-primary transition-colors"
            >
              Messenger
            </button>
            <button
              onClick={() => router.push('/auth/login')}
              className="px-3 py-2 bg-relay-surface hover:bg-relay-surface-hover rounded text-sm text-relay-text-primary transition-colors"
            >
              Login
            </button>
          </div>
        </motion.div>

        {/* Action Button */}
        <motion.button
          onClick={() => router.back()}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          className="w-full px-6 py-3 bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground font-semibold rounded-lg transition-all"
        >
          Go Back
        </motion.button>

        {/* Footer */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.7 }}
          className="text-xs text-relay-text-muted pt-4"
        >
          Error Code: 404 | Relay Secure Messenger
        </motion.p>
      </motion.div>
    </div>
  );
}
